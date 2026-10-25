import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors.js";
import { type Policy, type PolicyIssue, type PolicyRef, policyRef, validatePolicy } from "./policy.js";

/**
 * In-memory, versioned policy store with hot reload.
 *
 * - `active()` is what new runs read. A run keeps the object it read, so a publish never changes a
 *   run that is already in flight.
 * - Changes go draft -> publish. The approver must be a different person from the proposer
 *   (four-eyes). There is no way to edit the active policy in place.
 * - Rolling back republishes an old version's content as a new, higher version.
 * - Every action is appended to an audit log.
 * - With `persistDir`, every version (draft, active, retired, discarded) is kept in `policies.json` and every audit
 *   entry is appended to `audit.jsonl`, and both are read back on start, so a policy hash in a sealed record can
 *   still be looked up after a restart.
 */

export type PolicyStatus = "draft" | "active" | "retired" | "discarded";

export interface PolicyRecord {
  readonly policy: Policy;
  readonly status: PolicyStatus;
  readonly proposedBy: string;
  readonly approvedBy?: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly reason?: string;
  /** Version this draft was copied from, when it is a rollback. */
  readonly rollbackOf?: number;
}

export type PolicyAuditAction = "bootstrapped" | "draft_created" | "draft_discarded" | "published" | "publish_refused";

export interface PolicyAuditEntry {
  readonly ts: string;
  readonly actor: string;
  readonly action: PolicyAuditAction;
  readonly version: number;
  readonly detail?: string;
}

export interface PolicyChange {
  readonly type: "published";
  readonly version: number;
  readonly previousVersion: number | null;
  readonly ref: PolicyRef;
  readonly at: string;
}

export type PolicyChangeListener = (change: PolicyChange) => void;

export interface PolicyStoreOptions {
  now?: () => Date;
  /** Actor recorded for the initial policy. */
  bootstrapActor?: string;
  onListenerError?: (error: unknown, change: PolicyChange) => void;
  /** Folder that keeps every policy version and the audit log across restarts. Without it the store is in memory. */
  persistDir?: string;
}

interface PersistedState {
  activeVersion: number;
  records: Array<MutableRecord & { version: number }>;
}

interface MutableRecord {
  policy: Policy;
  status: PolicyStatus;
  proposedBy: string;
  approvedBy?: string;
  createdAt: string;
  publishedAt?: string;
  reason?: string;
  rollbackOf?: number;
}

export class PolicyStore {
  readonly #records = new Map<number, MutableRecord>();
  readonly #audit: PolicyAuditEntry[] = [];
  readonly #listeners = new Set<PolicyChangeListener>();
  readonly #now: () => Date;
  readonly #onListenerError?: (error: unknown, change: PolicyChange) => void;
  readonly #persistDir?: string;
  #activeVersion: number;

  constructor(initial: Policy, opts: PolicyStoreOptions = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#onListenerError = opts.onListenerError;
    this.#persistDir = opts.persistDir;
    const saved = this.#readSaved();
    if (saved) {
      for (const r of saved.records) {
        const validation = validatePolicy(r.policy);
        if (!validation.ok) throw invalidPolicy(validation.errors);
        const { version, ...rest } = r;
        this.#records.set(version, { ...rest, policy: freeze(validation.policy) });
      }
      this.#activeVersion = saved.activeVersion;
      this.#require(this.#activeVersion);
      this.#audit.push(...this.#readAudit());
      return;
    }
    const actor = opts.bootstrapActor ?? "system";
    const ts = this.#now().toISOString();
    const policy = freeze(initial);
    this.#records.set(policy.version, {
      policy,
      status: "active",
      proposedBy: actor,
      approvedBy: actor,
      createdAt: ts,
      publishedAt: ts,
    });
    this.#activeVersion = policy.version;
    this.#log(actor, "bootstrapped", policy.version, undefined, ts);
  }

  /** The policy new runs should use. The returned object is deeply frozen. */
  active(): Policy {
    return this.#require(this.#activeVersion).policy;
  }

  activeVersion(): number {
    return this.#activeVersion;
  }

  get(version: number): PolicyRecord | undefined {
    const record = this.#records.get(version);
    return record ? snapshot(record) : undefined;
  }

  list(): PolicyRecord[] {
    return [...this.#records.entries()].sort(([a], [b]) => a - b).map(([, r]) => snapshot(r));
  }

  audit(): readonly PolicyAuditEntry[] {
    return [...this.#audit];
  }

  /**
   * Create a draft from a full candidate policy. The version in the candidate is ignored: drafts always
   * get the next version number. Invalid candidates are rejected with per-field issues.
   */
  createDraft(candidate: unknown, proposedBy: string, reason?: string): PolicyRecord {
    const actor = requireActor(proposedBy, "proposer");
    const version = this.#nextVersion();
    const withVersion = isRecord(candidate) ? { ...candidate, version } : candidate;
    const validation = validatePolicy(withVersion);
    if (!validation.ok) throw invalidPolicy(validation.errors);
    return this.#addDraft(validation.policy, actor, reason);
  }

  /** Copy an earlier version into a new draft. It still needs a second person to publish it. */
  rollback(toVersion: number, proposedBy: string): PolicyRecord {
    const actor = requireActor(proposedBy, "proposer");
    const target = this.#records.get(toVersion);
    if (!target) throw new AppError("validation", `policy version ${toVersion} does not exist`);
    if (target.status === "draft" || target.status === "discarded") {
      throw new AppError("validation", `policy version ${toVersion} was never published`);
    }
    const draft = { ...structuredClone(target.policy), version: this.#nextVersion() };
    return this.#addDraft(draft, actor, `rollback to version ${toVersion}`, toVersion);
  }

  discardDraft(version: number, actor: string): void {
    const by = requireActor(actor, "actor");
    const record = this.#require(version);
    if (record.status !== "draft") throw new AppError("validation", `policy version ${version} is not a draft`);
    record.status = "discarded";
    this.#log(by, "draft_discarded", version);
  }

  /** Make a draft the active policy. Refused unless a different person approves it. */
  publish(version: number, approvedBy: string): PolicyChange {
    const approver = requireActor(approvedBy, "approver");
    const record = this.#require(version);
    if (record.status !== "draft") {
      throw new AppError("validation", `policy version ${version} is not a draft`);
    }
    if (approver === record.proposedBy) {
      this.#log(approver, "publish_refused", version, "approver is the proposer");
      throw new AppError("validation", "a second person must approve a policy change (four-eyes)", {
        details: { version },
      });
    }

    const previous = this.#require(this.#activeVersion);
    previous.status = "retired";
    const at = this.#now().toISOString();
    record.status = "active";
    record.approvedBy = approver;
    record.publishedAt = at;
    const previousVersion = this.#activeVersion;
    this.#activeVersion = version;
    this.#log(approver, "published", version, `replaces version ${previousVersion}`);

    const change: PolicyChange = {
      type: "published",
      version,
      previousVersion,
      ref: policyRef(record.policy),
      at,
    };
    this.#notify(change);
    return change;
  }

  subscribe(listener: PolicyChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #addDraft(policy: Policy, proposedBy: string, reason?: string, rollbackOf?: number): PolicyRecord {
    const frozen = freeze(policy);
    const record: MutableRecord = {
      policy: frozen,
      status: "draft",
      proposedBy,
      createdAt: this.#now().toISOString(),
      reason,
      rollbackOf,
    };
    this.#records.set(frozen.version, record);
    this.#log(proposedBy, "draft_created", frozen.version, reason);
    return snapshot(record);
  }

  #nextVersion(): number {
    return Math.max(...this.#records.keys()) + 1;
  }

  #require(version: number): MutableRecord {
    const record = this.#records.get(version);
    if (!record) throw new AppError("validation", `policy version ${version} does not exist`);
    return record;
  }

  #log(actor: string, action: PolicyAuditAction, version: number, detail?: string, ts?: string): void {
    const entry = { ts: ts ?? this.#now().toISOString(), actor, action, version, ...(detail ? { detail } : {}) };
    this.#audit.push(entry);
    if (!this.#persistDir) return;
    mkdirSync(this.#persistDir, { recursive: true });
    appendFileSync(join(this.#persistDir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o640 });
    this.#save();
  }

  /** Write every version and the active one, through a temporary file so a crash never leaves half a file. */
  #save(): void {
    if (!this.#persistDir) return;
    const state: PersistedState = {
      activeVersion: this.#activeVersion,
      records: [...this.#records.entries()].map(([version, r]) => ({ version, ...r })),
    };
    const file = join(this.#persistDir, "policies.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
    renameSync(`${file}.tmp`, file);
  }

  #readSaved(): PersistedState | undefined {
    if (!this.#persistDir) return undefined;
    const file = join(this.#persistDir, "policies.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as PersistedState;
  }

  #readAudit(): PolicyAuditEntry[] {
    const file = join(this.#persistDir ?? "", "audit.jsonl");
    if (!this.#persistDir || !existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PolicyAuditEntry);
  }

  #notify(change: PolicyChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        try {
          this.#onListenerError?.(error, change);
        } catch {
          // A broken error hook must not undo a publish.
        }
      }
    }
  }
}

function requireActor(value: string, role: string): string {
  const actor = value.trim();
  if (actor.length === 0) throw new AppError("validation", `a named ${role} is required`);
  return actor;
}

function invalidPolicy(issues: PolicyIssue[]): AppError {
  return new AppError("validation", "invalid policy", { details: { issues } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function snapshot(record: MutableRecord): PolicyRecord {
  return { ...record };
}

/** Deep copy then deep freeze, so a pinned policy can never change under a running agent. */
function freeze<T>(value: T): T {
  const copy = structuredClone(value);
  const walk = (v: unknown): void => {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const child of Object.values(v)) walk(child);
    }
  };
  walk(copy);
  return copy;
}

// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Sleep cycle. preview() computes the whole action plan and changes nothing; execute() takes a backup
// first and restore() can undo it. Guardrails: superseding records, derived or synthesised memories and
// relationship hubs are never archived.

import { cosine } from "./embeddings.js";
import type { MemoryStoreService } from "./memory-store.js";
import type { TrustLedgerService } from "./trust-ledger.js";
import type { MemoryRecord, SleepPreview, SleepReport } from "./types.js";
import { DAY_MS, DEFAULTS } from "./types.js";

const HUB_THRESHOLD = 3;

export class SleepCycleService {
  private backups = new Map<string, { records: MemoryRecord[]; seq: number }>();
  private backupSeq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly actor: string,
  ) {}

  preview(): SleepPreview {
    const now = this.clock();
    const all = this.store.all();
    const referenced = referencedIds(all);

    const toConsolidate = all
      .filter((m) => m.layer === "short_term" && now - m.lastAccessed >= DEFAULTS.consolidationDays * DAY_MS)
      .map((m) => m.id);

    const toArchive = all.filter((m) => archivable(m, now, referenced)).map((m) => m.id);

    return { toConsolidate, toArchive, toSynthesize: synthesisGroups(all) };
  }

  execute(preview?: SleepPreview): SleepReport {
    const plan = preview ?? this.preview();
    this.backupSeq += 1;
    const backupId = `backup-${this.backupSeq}`;
    this.backups.set(backupId, this.store.snapshotAll());
    const actionLog: string[] = [`backup ${backupId} created`];

    this.consolidate(plan.toConsolidate, actionLog);
    this.archive(plan.toArchive, actionLog);
    const synthesized = this.synthesize(plan.toSynthesize, actionLog);

    this.store.persist();
    return {
      backupId,
      consolidated: plan.toConsolidate.length,
      archived: plan.toArchive.length,
      synthesized,
      actionLog,
    };
  }

  restore(backupId: string): void {
    const backup = this.backups.get(backupId);
    if (!backup) throw new Error(`H-MEM: unknown backup ${backupId}`);
    this.store.restoreAll(backup.records, backup.seq);
    this.ledger.log("*", "restore", this.actor, { details: { backupId } });
  }

  private consolidate(ids: string[], actionLog: string[]): void {
    for (const id of ids) {
      if (!this.store.get(id)) continue;
      this.store.promote(id, "long_term");
      this.ledger.log(id, "sleep_consolidate", this.actor, { details: { from: "short_term", to: "long_term" } });
      actionLog.push(`consolidated ${id}`);
    }
  }

  private archive(ids: string[], actionLog: string[]): void {
    for (const id of ids) {
      const m = this.store.get(id);
      if (!m) continue;
      this.ledger.log(id, "sleep_archive", this.actor, {
        details: { age: this.clock() - m.timestamp, accessCount: m.accessCount },
      });
      this.store.delete(id, "sleep archive");
      actionLog.push(`archived ${id}`);
    }
  }

  private synthesize(groups: string[][], actionLog: string[]): number {
    let count = 0;
    for (const group of groups) {
      const members = group.map((id) => this.store.get(id)).filter((m): m is MemoryRecord => m !== undefined);
      if (members.length < 2) continue;
      const merged = this.store.add({
        content: `Synthesis: ${members.map((m) => m.content).join(" | ")}`,
        type: "factual",
        layer: "long_term",
        tags: [...new Set(members.flatMap((m) => m.tags))],
        confidence: Math.max(...members.map((m) => m.confidence)),
        source: "sleep:synthesis",
        provenance: {
          origin: "sleep_synthesis",
          learnedAt: this.clock(),
          label: `synthesized from ${members.length} memories`,
        },
        derivedFrom: members.map((m) => m.id),
      });
      this.ledger.log(merged.id, "sleep_synthesize", this.actor, { details: { sources: group } });
      for (const m of members) this.store.delete(m.id, "merged by sleep synthesis");
      count += 1;
      actionLog.push(`synthesized ${merged.id} from ${group.join(", ")}`);
    }
    return count;
  }
}

function referencedIds(all: MemoryRecord[]): Set<string> {
  const referenced = new Set<string>();
  for (const m of all) {
    for (const r of m.relatedTo) referenced.add(r);
    if (m.supersedes) referenced.add(m.supersedes);
    for (const d of m.derivedFrom ?? []) referenced.add(d);
  }
  return referenced;
}

/** Old, rarely used, unreferenced, and none of the three protected classes. */
function archivable(m: MemoryRecord, now: number, referenced: Set<string>): boolean {
  const oldEnough = now - m.timestamp >= DEFAULTS.archiveMinDays * DAY_MS;
  const lowAccess = m.accessCount <= DEFAULTS.archiveMaxAccess;
  if (!(oldEnough && lowAccess) || referenced.has(m.id)) return false;
  if (m.supersedes) return false;
  if ((m.derivedFrom ?? []).length > 0) return false;
  return m.relatedTo.length < HUB_THRESHOLD;
}

function synthesisGroups(all: MemoryRecord[]): string[][] {
  const groups: string[][] = [];
  const used = new Set<string>();
  all.forEach((seed, i) => {
    if (used.has(seed.id)) return;
    const near = all
      .slice(i + 1)
      .filter((other) => !used.has(other.id) && cosine(seed.embedding, other.embedding) >= DEFAULTS.synthesisCosine);
    if (near.length === 0) return;
    const group = [seed, ...near].map((g) => g.id);
    for (const id of group) used.add(id);
    groups.push(group);
  });
  return groups;
}

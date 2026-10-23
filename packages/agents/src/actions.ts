import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  type Decision,
  type DecisionRecord,
  type HumanAction,
  hashValue,
  type Policy,
  sha256Hex,
} from "@sanctions-desk/shared";
import { type HumanState, humanState } from "./human-state.js";

/**
 * What happens after a person approves a recommendation. The next step is prepared as a record in a local outbox:
 * a closure note, an escalation ticket, a request-for-information draft, a hold instruction, or (after a second
 * approval) a block recommendation for the sanctions officer. Nothing is sent, executed or written to a source
 * system. Each record is signed with an Ed25519 key kept outside the repository when one is configured, and is
 * otherwise only hash-sealed, and says which.
 */

export const ACTION_KINDS = [
  "closure_note",
  "escalation_ticket",
  "rfi_draft",
  "hold_instruction",
  "block_recommendation",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionBody {
  kind: ActionKind;
  alert_id: string;
  alert_type: "customer" | "payment";
  /** The sealed record this action rests on, including the person's decision. */
  record_hash: string;
  recommended: Decision;
  final: Decision;
  /** For example "block approval pending". */
  status: string;
  title: string;
  /** The text of the note, ticket or draft. Plain words; never wording for a customer that reveals screening. */
  content: string;
  decided_by: Array<{ id: string; role?: string; action: string; at: string; reason?: string }>;
  policy: { version: number; hash: string };
  /** Always false: the desk prepares records and drafts, it never sends or executes them. */
  sent: false;
  created_at: string;
}

export type Seal = { type: "hash-sealed" } | { type: "ed25519"; key_id: string; public_key: string; signature: string };

export interface ActionRecord {
  action_id: string;
  body: ActionBody;
  body_hash: string;
  seal: Seal;
}

export interface Signer {
  keyId: string;
  /** Raw Ed25519 public key, base64. */
  publicKey: string;
  sign(bytes: Buffer): string;
}

const rawPublicKey = (pem: string): string => {
  const der = createPublicKey(pem).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
};

/** Read the signing key from a PEM file outside the repository. Undefined when none is configured. */
export function loadSigner(path: string | undefined): Signer | undefined {
  if (!path) return undefined;
  if (!existsSync(path)) throw new Error(`the signing key file ${path} does not exist`);
  const key = createPrivateKey(readFileSync(path, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the signing key must be an Ed25519 key");
  const publicKey = rawPublicKey(createPublicKey(key).export({ format: "pem", type: "spki" }).toString());
  return {
    keyId: sha256Hex(publicKey).slice(0, 16),
    publicKey,
    sign: (bytes) => sign(null, bytes, key).toString("base64"),
  };
}

const REASON_TEXT: Record<Decision, string> = {
  CLOSE_FALSE_POSITIVE: "closed as a false positive",
  ESCALATE_L2: "escalated to level 2",
  NEED_MORE_INFO: "more information requested",
  RECOMMEND_BLOCK: "a block is recommended",
};

const people = (record: DecisionRecord): ActionBody["decided_by"] =>
  record.human.map((h: HumanAction) => ({
    id: h.actor,
    ...(h.role ? { role: h.role } : {}),
    action: h.action,
    at: h.at,
    ...(h.reason ? { reason: h.reason } : {}),
  }));

const tippingOff = (policy: Policy, text: string): boolean =>
  policy.guards.tippingOffPatterns.some((p) => new RegExp(p, "iu").test(text));

/** A neutral request for the missing information. If the listed items would reveal anything, only the general text stays. */
export function rfiText(policy: Policy, items: readonly string[]): string {
  const general =
    "Thank you for banking with us. To complete a routine update of our records, please send the documents or details listed below.";
  const list = items.filter((i) => i.trim() !== "" && !tippingOff(policy, i)).slice(0, 5);
  return list.length > 0
    ? `${general}\n- ${list.join("\n- ")}`
    : `${general}\n- A recent proof of identity and address`;
}

/** The records that follow a person's decision. Empty while nothing has been decided. */
export function planActions(record: DecisionRecord, policy: Policy, now: Date): ActionBody[] {
  const state = humanState(record);
  if (state.status === "awaiting") return [];
  const base = {
    alert_id: record.alert_ref,
    alert_type: record.alert_type,
    record_hash: record.record_hash,
    recommended: record.decision,
    decided_by: people(record),
    policy: { version: policy.version, hash: record.policy.hash },
    sent: false as const,
    created_at: now.toISOString(),
  };
  const reasonOf = (a?: HumanAction) => (a?.reason ? ` Reason given: ${a.reason}` : "");
  const out: ActionBody[] = [];
  const final: Decision = state.status === "block_pending" ? "RECOMMEND_BLOCK" : (state.final as Decision);
  const b = { ...base, final };
  if (state.status === "block_pending") {
    out.push({
      ...b,
      kind: "escalation_ticket",
      status: "block approval pending",
      title: `Block approval pending: ${record.alert_ref}`,
      content: `A block is recommended for this alert and has one approval. A second, different approver must confirm before the sanctions officer receives a block recommendation. Nothing has been blocked.${reasonOf(state.first)}`,
    });
    return out;
  }
  if (state.status === "block_approved") {
    out.push({
      ...b,
      kind: "block_recommendation",
      status: "ready for the sanctions officer",
      title: `Block recommendation for the sanctions officer: ${record.alert_ref}`,
      content: `Two different approvers support a block. This is a recommendation for the sanctions officer to act on; the desk has not blocked anything.${reasonOf(state.first)}${reasonOf(state.second)}`,
    });
  } else if (state.final === "CLOSE_FALSE_POSITIVE") {
    out.push({
      ...b,
      kind: "closure_note",
      status: "closed by a person",
      title: `Closure note: ${record.alert_ref}`,
      content: `Alert ${record.alert_ref} was ${REASON_TEXT.CLOSE_FALSE_POSITIVE} by ${state.first?.actor}.${reasonOf(state.first)} Basis: ${record.rationale}`,
    });
  } else if (state.final === "NEED_MORE_INFO") {
    out.push({
      ...b,
      kind: "rfi_draft",
      status: "draft, not sent",
      title: `Request for information (draft): ${record.alert_ref}`,
      content: rfiText(policy, record.what_would_change),
    });
  } else {
    out.push({
      ...b,
      kind: "escalation_ticket",
      status: state.status === "block_declined" ? "escalated after the block was declined" : "open",
      title: `Level 2 review: ${record.alert_ref}`,
      content: `Alert ${record.alert_ref} was ${REASON_TEXT.ESCALATE_L2}.${reasonOf(state.status === "block_declined" ? state.second : state.first)} Basis: ${record.rationale}`,
    });
  }
  if (record.alert_type === "payment" && (final === "ESCALATE_L2" || final === "RECOMMEND_BLOCK")) {
    out.push({
      ...b,
      kind: "hold_instruction",
      status: "draft, not executed",
      title: `Hold instruction (draft): payment under alert ${record.alert_ref}`,
      content: `Draft instruction for payment operations to hold the pending payment under alert ${record.alert_ref} until a person has finished the review. The desk does not hold or release payments.`,
    });
  }
  return out;
}

export function sealAction(body: ActionBody, id: string, signer?: Signer): ActionRecord {
  const bytes = Buffer.from(canonicalJson(body));
  const body_hash = hashValue(body);
  const seal: Seal = signer
    ? { type: "ed25519", key_id: signer.keyId, public_key: signer.publicKey, signature: signer.sign(bytes) }
    : { type: "hash-sealed" };
  return { action_id: id, body, body_hash, seal };
}

export type ActionCheck = "signed_and_pinned" | "signed_unpinned" | "hash_sealed" | "invalid";

/** `signed_and_pinned` only when the signature verifies against the public key the deployment configured. */
export function verifyAction(record: ActionRecord, pinnedPublicKey?: string): ActionCheck {
  if (hashValue(record.body) !== record.body_hash) return "invalid";
  if (record.seal.type === "hash-sealed") return "hash_sealed";
  try {
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(record.seal.public_key, "base64"),
    ]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const ok = verify(null, Buffer.from(canonicalJson(record.body)), key, Buffer.from(record.seal.signature, "base64"));
    if (!ok) return "invalid";
    return pinnedPublicKey !== undefined && pinnedPublicKey === record.seal.public_key
      ? "signed_and_pinned"
      : "signed_unpinned";
  } catch {
    return "invalid";
  }
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function writeActions(dir: string, bodies: readonly ActionBody[], signer?: Signer): ActionRecord[] {
  const out: ActionRecord[] = [];
  for (const body of bodies) {
    const folder = join(dir, safeName(body.alert_id));
    mkdirSync(folder, { recursive: true });
    const id = `${body.kind}-${body.record_hash.slice(0, 12)}`;
    const record = sealAction(body, id, signer);
    writeFileSync(join(folder, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640 });
    out.push(record);
  }
  return out;
}

/** The records written for one alert, newest first. */
export function readActions(dir: string, alertId: string): ActionRecord[] {
  const folder = join(dir, safeName(alertId));
  if (!existsSync(folder)) return [];
  const out: ActionRecord[] = [];
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(folder, name), "utf8")) as ActionRecord);
    } catch {
      // not an action record
    }
  }
  return out.sort((a, b) => b.body.created_at.localeCompare(a.body.created_at));
}

export type { HumanState };

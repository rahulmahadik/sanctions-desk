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

const ACTION_KINDS = [
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
  /** For a draft meant for a customer: the tipping-off check it passed (or failed) before it was saved. */
  tipping_off_check?: TippingOffCheck;
  /** For a draft meant for a customer: always true, a person must approve the wording before it is used. */
  needs_approval?: true;
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

/**
 * Wording that would tell a customer they were screened, matched, escalated or considered for a block. Every draft
 * meant for a customer is checked against these on top of the policy's own tipping-off patterns; a policy cannot
 * remove them.
 */
export const TIPPING_OFF_FLOOR = [
  "\\blist(s|ed|ing)?\\b",
  "\\bmatch(es|ed|ing)?\\b",
  "\\balerts?\\b",
  "escalat",
  "\\bblock(s|ed|ing)?\\b",
  "\\bhold(s|ing)?\\b",
  "complian(ce|t)",
  "due diligence",
  "\\bflag(s|ged)?\\b",
  "\\bsuspect",
  "false.positive",
  "true.match",
  "RECOMMEND_BLOCK|CLOSE_FALSE_POSITIVE|ESCALATE_L2|NEED_MORE_INFO",
];

export interface TippingOffCheck {
  passed: boolean;
  /** The patterns that matched. */
  hits: string[];
}

/** Check wording meant for a customer against the policy's tipping-off patterns and the fixed floor above. */
export function checkTippingOff(policy: Policy, text: string): TippingOffCheck {
  const hits = [...policy.guards.tippingOffPatterns, ...TIPPING_OFF_FLOOR].filter((p) =>
    new RegExp(p, "iu").test(text),
  );
  return { passed: hits.length === 0, hits };
}

/**
 * What a request for information asks for. Fixed wording chosen by the kind of alert: never text a model wrote, which
 * can describe the match ("if the listed party had a date of birth matching ...").
 */
const RFI_ITEMS: Record<"customer" | "payment", string[]> = {
  customer: [
    "A recent proof of identity, such as a passport or national identity card",
    "A recent proof of address, such as a utility bill or bank statement from the last three months",
    "An official document that shows your date of birth",
  ],
  payment: [
    "The purpose of the payment",
    "The full name and address of the other party to the payment",
    "A supporting document for the payment, such as an invoice or contract",
  ],
};

/** A neutral request for information, and the tipping-off check it was put through. */
export function rfiText(policy: Policy, alertType: "customer" | "payment"): { text: string; check: TippingOffCheck } {
  const general =
    "Thank you for banking with us. To complete a routine update of our records, please send the documents or details set out below.";
  const text = `${general}\n- ${RFI_ITEMS[alertType].join("\n- ")}`;
  return { text, check: checkTippingOff(policy, text) };
}

type Base = Omit<ActionBody, "kind" | "status" | "title" | "content" | "tipping_off_check" | "needs_approval">;

const reasonOf = (a?: HumanAction): string => (a?.reason ? ` Reason given: ${a.reason}` : "");

/** The record that follows a settled decision other than a block waiting for its second approval. */
function settledAction(record: DecisionRecord, policy: Policy, state: HumanState): Omit<ActionBody, keyof Base> {
  if (state.status === "block_approved") {
    return {
      kind: "block_recommendation",
      status: "ready for the sanctions officer",
      title: `Block recommendation for the sanctions officer: ${record.alert_ref}`,
      content: `Two different approvers support a block. This is a recommendation for the sanctions officer to act on; the desk has not blocked anything.${reasonOf(state.first)}${reasonOf(state.second)}`,
    };
  }
  if (state.final === "CLOSE_FALSE_POSITIVE") {
    return {
      kind: "closure_note",
      status: "closed by a person",
      title: `Closure note: ${record.alert_ref}`,
      content: `Alert ${record.alert_ref} was ${REASON_TEXT.CLOSE_FALSE_POSITIVE} by ${state.first?.actor}.${reasonOf(state.first)} Basis: ${record.rationale}`,
    };
  }
  if (state.final === "NEED_MORE_INFO") {
    const { text, check } = rfiText(policy, record.alert_type);
    return {
      kind: "rfi_draft",
      status: check.passed
        ? "draft, not sent; a person must approve the wording before it is used"
        : "draft withheld: the wording failed the tipping-off check",
      title: `Request for information (draft): ${record.alert_ref}`,
      content: check.passed
        ? text
        : `The draft was withheld because its wording failed the tipping-off check (${check.hits.join(", ")}). Write the request by hand and have it approved.`,
      tipping_off_check: check,
      needs_approval: true,
    };
  }
  const declined = state.status === "block_declined";
  return {
    kind: "escalation_ticket",
    status: declined ? "escalated after the block was declined" : "open",
    title: `Level 2 review: ${record.alert_ref}`,
    content: `Alert ${record.alert_ref} was ${REASON_TEXT.ESCALATE_L2}.${reasonOf(declined ? state.second : state.first)} Basis: ${record.rationale}`,
  };
}

/** The closure note for a close the desk made on its own. */
function autoClosedAction(record: DecisionRecord, policy: Policy, now: Date): ActionBody {
  return {
    kind: "closure_note",
    alert_id: record.alert_ref,
    alert_type: record.alert_type,
    record_hash: record.record_hash,
    recommended: record.decision,
    final: "CLOSE_FALSE_POSITIVE",
    status: "closed automatically; a person can reopen it",
    title: `Closure note (automatic): ${record.alert_ref}`,
    content: `${record.autonomy?.statement ?? "closed automatically"}. Basis: ${record.rationale}`,
    decided_by: [],
    policy: { version: policy.version, hash: record.policy.hash },
    sent: false,
    created_at: now.toISOString(),
  };
}

/** The records that follow a person's decision. Empty while nothing has been decided. */
export function planActions(record: DecisionRecord, policy: Policy, now: Date): ActionBody[] {
  const state = humanState(record);
  if (state.status === "awaiting") return [];
  if (state.status === "auto_closed") return [autoClosedAction(record, policy, now)];
  const final: Decision = state.status === "block_pending" ? "RECOMMEND_BLOCK" : (state.final as Decision);
  const b: Base = {
    alert_id: record.alert_ref,
    alert_type: record.alert_type,
    record_hash: record.record_hash,
    recommended: record.decision,
    final,
    decided_by: people(record),
    policy: { version: policy.version, hash: record.policy.hash },
    sent: false,
    created_at: now.toISOString(),
  };
  if (state.status === "block_pending") {
    return [
      {
        ...b,
        kind: "escalation_ticket",
        status: "block approval pending",
        title: `Block approval pending: ${record.alert_ref}`,
        content: `A block is recommended for this alert and has one approval. A second, different approver must confirm before the sanctions officer receives a block recommendation. Nothing has been blocked.${reasonOf(state.first)}`,
      },
    ];
  }
  const out: ActionBody[] = [{ ...b, ...settledAction(record, policy, state) }];
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

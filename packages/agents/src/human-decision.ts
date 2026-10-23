import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Actor,
  AppError,
  appendHumanAction,
  can,
  type Decision,
  type DecisionRecord,
  type HumanAction,
  type Policy,
} from "@sanctions-desk/shared";
import { type ActionRecord, planActions, type Signer, writeActions } from "./actions.js";
import { appendAnalystMemory } from "./analyst-memory.js";
import { humanState } from "./human-state.js";
import { CAUTION } from "./policy-guard.js";
import { writeDecisionRecord } from "./record.js";

/**
 * The human decision step. A person approves a recommendation or overrides it, always with a reason, and the next
 * action is prepared only after that. The rules, each enforced here and each tested:
 *
 *   1. only analysts and approvers decide; viewers and policy admins cannot
 *   2. a reason is required for an approval and for an override
 *   3. the decision names the sealed record it is about; if a newer record exists it is refused
 *   4. an override must name a different outcome than the recommendation
 *   5. an override towards a less cautious outcome needs an approver
 *   6. a block (recommended and approved, or chosen in an override) is not final: it needs a second approval
 *   7. the second approver must be an approver and a different person from the first
 *   8. a case that is settled cannot be decided again
 *   9. everything, including refusals, is written to the audit log under the person's id
 */

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 600;

export interface DecisionRequest {
  action: "approve" | "override";
  /** Required for an override. */
  outcome?: Decision;
  reason: string;
  /** The hash of the sealed record the person was looking at. */
  record_hash: string;
}

export interface SecondApprovalRequest {
  approve: boolean;
  reason: string;
  record_hash: string;
}

const refuse = (type: "forbidden" | "conflict" | "validation", message: string): never => {
  throw new AppError(type, message);
};

function checkCommon(record: DecisionRecord, actor: Actor, reason: string, recordHash: string): string {
  if (!can(actor, "decide")) refuse("forbidden", `${actor.role} may not record decisions on recommendations`);
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH)
    refuse("validation", `a reason of at least ${MIN_REASON_LENGTH} characters is required`);
  if (trimmed.length > MAX_REASON_LENGTH)
    refuse("validation", `the reason is longer than ${MAX_REASON_LENGTH} characters`);
  if (recordHash !== record.record_hash)
    refuse("conflict", "the recommendation changed since you looked at it; reload the case and decide again");
  return trimmed;
}

/** The first decision on a recommendation. Returns the record extended with the person's action. */
export function recordDecision(
  record: DecisionRecord,
  request: DecisionRequest,
  actor: Actor,
  now: Date,
): DecisionRecord {
  const reason = checkCommon(record, actor, request.reason, request.record_hash);
  if (humanState(record).status !== "awaiting") refuse("conflict", "this recommendation has already been decided");
  let outcome: Decision = record.decision;
  if (request.action === "override") {
    if (request.outcome === undefined) refuse("validation", "an override names the outcome you choose");
    outcome = request.outcome as Decision;
    if (outcome === record.decision)
      refuse("validation", "an override must choose a different outcome; use approve to agree");
    if (CAUTION[outcome] < CAUTION[record.decision] && !can(actor, "overrideTowardsLessCaution"))
      refuse("forbidden", "only an approver may override towards a less cautious outcome");
  } else if (request.outcome !== undefined && request.outcome !== record.decision) {
    refuse("validation", "an approval agrees with the recommendation; use override to choose another outcome");
  }
  const action: HumanAction = {
    action: request.action,
    actor: actor.id,
    role: actor.role,
    at: now.toISOString(),
    reason,
    outcome,
  };
  return appendHumanAction(record, action, nextRecordId(record));
}

export interface ReopenRequest {
  reason: string;
  record_hash: string;
}

/** A person reopens a close the desk made automatically. The case then waits for a decision like any other. */
export function reopen(record: DecisionRecord, request: ReopenRequest, actor: Actor, now: Date): DecisionRecord {
  if (humanState(record).status !== "auto_closed")
    refuse("conflict", "only a close made automatically can be reopened");
  const reason = checkCommon(record, actor, request.reason, request.record_hash);
  const action: HumanAction = { action: "reopen", actor: actor.id, role: actor.role, at: now.toISOString(), reason };
  return appendHumanAction(record, action, nextRecordId(record));
}

/** The second approval (or refusal) of a block. */
export function secondApproval(
  record: DecisionRecord,
  request: SecondApprovalRequest,
  actor: Actor,
  now: Date,
): DecisionRecord {
  const state = humanState(record);
  if (state.status !== "block_pending") refuse("conflict", "this recommendation is not waiting for a second approval");
  const reason = checkCommon(record, actor, request.reason, request.record_hash);
  if (!can(actor, "approveBlock")) refuse("forbidden", "the second approval of a block must come from an approver");
  if (state.first?.actor === actor.id) refuse("forbidden", "the second approval must come from a different person");
  const action: HumanAction = {
    action: request.approve ? "second_approval" : "reject",
    actor: actor.id,
    role: actor.role,
    at: now.toISOString(),
    reason,
    outcome: request.approve ? "RECOMMEND_BLOCK" : "ESCALATE_L2",
  };
  return appendHumanAction(record, action, nextRecordId(record));
}

const nextRecordId = (record: DecisionRecord): string =>
  `${record.record_id.replace(/-h\d+$/, "")}-h${record.human.length + 1}`.slice(0, 100);

export interface DeskStores {
  logDir: string;
  outboxDir: string;
  signer?: Signer;
}

/** Where the customer and listed entry behind an alert come from, so the decision can be remembered. */
export interface CaseRef {
  customerId: string;
  entryId: string;
}

/** The note that goes with a close the desk made automatically, and a line in the audit log under the policy. */
export function recordAutoClose(stores: DeskStores, policy: Policy, record: DecisionRecord, now: Date): ActionRecord[] {
  audit(stores.logDir, {
    user: "policy",
    role: "system",
    action: "auto_close",
    alert_id: record.alert_ref,
    record_hash: record.record_hash,
    result: record.autonomy?.statement,
  });
  return writeActions(stores.outboxDir, planActions(record, policy, now), stores.signer);
}

export interface Committed {
  record: DecisionRecord;
  status: ReturnType<typeof humanState>["status"];
  actions: ActionRecord[];
}

const auditFile = (logDir: string): string => join(logDir, "decisions", "audit.jsonl");

export function audit(logDir: string, entry: Record<string, unknown>): void {
  const file = auditFile(logDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o640 });
}

/** Write the extended record, prepare the next actions and remember the decision. */
export function commit(stores: DeskStores, policy: Policy, next: DecisionRecord, ref: CaseRef, now: Date): Committed {
  writeDecisionRecord(stores.logDir, next);
  const state = humanState(next);
  const actions = writeActions(stores.outboxDir, planActions(next, policy, now), stores.signer);
  if (state.final !== undefined) {
    const last = next.human.at(-1) as HumanAction;
    appendAnalystMemory(stores.logDir, {
      disposition_id: `dsk-${next.record_id}`,
      customer_id: ref.customerId,
      entry_id: ref.entryId,
      entry_content_hash: next.list_snapshots[0]?.content_hash ?? "",
      list_snapshot_id: next.list_snapshots[0]?.snapshot_id ?? null,
      decision: state.final,
      reason_codes: `ANALYST_${(state.first?.action ?? "approve").toUpperCase()}`,
      decided_at: last.at,
      decided_by: last.actor,
      reason: last.reason ?? "",
      decision_record_hash: next.record_hash,
    });
  }
  return { record: next, status: state.status, actions };
}

/** Run a decision attempt, log it under the person's id whether it is accepted or refused, and commit it. */
export function attempt(
  stores: DeskStores,
  policy: Policy,
  actor: Actor,
  what: string,
  record: DecisionRecord,
  ref: CaseRef,
  now: Date,
  run: () => DecisionRecord,
): Committed {
  try {
    const committed = commit(stores, policy, run(), ref, now);
    audit(stores.logDir, {
      user: actor.id,
      role: actor.role,
      action: what,
      alert_id: record.alert_ref,
      record_hash: record.record_hash,
      result: committed.status,
    });
    return committed;
  } catch (err) {
    audit(stores.logDir, {
      user: actor.id,
      role: actor.role,
      action: what,
      alert_id: record.alert_ref,
      record_hash: record.record_hash,
      result: "refused",
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

import type { Decision, DecisionRecord, HumanAction } from "@sanctions-desk/shared";

/**
 * Where a recommendation stands once people have acted on it, read from the actions in its sealed record.
 *
 *   awaiting        nobody has decided (this includes a quality-assurance sample, and a close that was reopened)
 *   auto_closed     closed automatically under the autonomy setting; a person can reopen it
 *   decided         one approval or override settled it (anything except a block)
 *   block_pending   a block has one approval and waits for a second, different approver
 *   block_approved  a second approver agreed; a block recommendation goes to the sanctions officer
 *   block_declined  the second approver declined; the case is escalated instead
 */
export type HumanStatus =
  | "awaiting"
  | "auto_closed"
  | "decided"
  | "block_pending"
  | "block_approved"
  | "block_declined";

export interface HumanState {
  status: HumanStatus;
  /** The settled outcome. Undefined while a block waits for its second approval. */
  final?: Decision;
  first?: HumanAction;
  second?: HumanAction;
}

export function humanState(record: DecisionRecord): HumanState {
  if (record.autonomy?.outcome === "auto_closed" && !record.human.some((a) => a.action === "reopen"))
    return { status: "auto_closed", final: "CLOSE_FALSE_POSITIVE" };
  const first = record.human.find((a) => a.action === "approve" || a.action === "override");
  if (!first) return { status: "awaiting" };
  const outcome = first.outcome ?? record.decision;
  if (outcome !== "RECOMMEND_BLOCK") return { status: "decided", final: outcome, first };
  const second = record.human.find((a) => a.action === "second_approval" || a.action === "reject");
  if (!second) return { status: "block_pending", first };
  return second.action === "second_approval"
    ? { status: "block_approved", final: "RECOMMEND_BLOCK", first, second }
    : { status: "block_declined", final: "ESCALATE_L2", first, second };
}

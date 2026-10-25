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
 *   override_pending  a person overrode the recommendation to a close (lowering caution); it waits for a second,
 *                     different approver
 *   override_approved the second approver agreed; the close stands
 *   override_declined the second approver declined; the case is escalated instead
 */
export type HumanStatus =
  | "awaiting"
  | "auto_closed"
  | "decided"
  | "block_pending"
  | "block_approved"
  | "block_declined"
  | "override_pending"
  | "override_approved"
  | "override_declined";

/** An override to a close from a more cautious recommendation needs a second, different approver. */
export const needsSecondForClose = (recommended: Decision, outcome: Decision): boolean =>
  outcome === "CLOSE_FALSE_POSITIVE" && recommended !== "CLOSE_FALSE_POSITIVE";

export interface HumanState {
  status: HumanStatus;
  /** The settled outcome. Undefined while nobody has decided or a second approval is pending. */
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
  const second = record.human.find((a) => a.action === "second_approval" || a.action === "reject");
  if (first.action === "override" && needsSecondForClose(record.decision, outcome)) {
    if (!second) return { status: "override_pending", first };
    return second.action === "second_approval"
      ? { status: "override_approved", final: "CLOSE_FALSE_POSITIVE", first, second }
      : { status: "override_declined", final: "ESCALATE_L2", first, second };
  }
  if (outcome !== "RECOMMEND_BLOCK") return { status: "decided", final: outcome, first };
  if (!second) return { status: "block_pending", first };
  return second.action === "second_approval"
    ? { status: "block_approved", final: "RECOMMEND_BLOCK", first, second }
    : { status: "block_declined", final: "ESCALATE_L2", first, second };
}

import { scoutIntent } from "@sanctions-desk/engines";
import type { Decision } from "@sanctions-desk/shared";
import type { ActionBody, ActionKind } from "./actions.js";

/**
 * Optional (config `actions.scoutIntent`, off by default): before a next-action record is sealed, Scout Intent reads
 * its title and text, names the action it is (closure note, escalation ticket, request for information, hold
 * instruction, block recommendation), and issues a signed execution contract for it. The record is written only
 * when that intent is the record's own kind and the kind is one the person's decision allows; anything else is
 * refused and not written. This runs after a person has decided: it never changes a review or a decision.
 */

const intent = (kind: ActionKind) => `action.${kind}`;

/** The intent registry for next-action records. Examples are the wording the desk itself writes. */
export const ACTION_REGISTRY: scoutIntent.IntentRegistry = {
  version: 1,
  intents: [
    {
      id: "GENERAL",
      description: "Anything that is not a next-action record of the desk.",
      capabilities: [],
      riskClass: "low",
      examples: ["hello", "what can you help me with"],
    },
    {
      id: intent("closure_note"),
      description: "Closure note: the alert was closed as a false positive by a person, or closed automatically.",
      capabilities: ["outbox.write", "case.close_note"],
      riskClass: "low",
      examples: [
        "Closure note: alert closed as a false positive by an analyst",
        "Closure note (automatic): closed automatically; a person can reopen it",
      ],
    },
    {
      id: intent("escalation_ticket"),
      description: "Level 2 review ticket: the alert was escalated to level 2, or a block approval is pending.",
      capabilities: ["outbox.write", "ticket.open"],
      riskClass: "medium",
      examples: [
        "Level 2 review: alert escalated to level 2",
        "Block approval pending: a block is recommended and has one approval; a second approver must confirm",
      ],
    },
    {
      id: intent("rfi_draft"),
      description: "Request for information draft: ask the customer for documents; not sent, a person approves it.",
      capabilities: ["outbox.write", "draft.customer_message", "approval.require"],
      riskClass: "medium",
      examples: [
        "Request for information (draft): please send the documents or details set out below",
        "Request for information draft withheld: the wording failed the tipping-off check",
      ],
    },
    {
      id: intent("hold_instruction"),
      description: "Hold instruction draft for payment operations: hold the pending payment until review ends.",
      capabilities: ["outbox.write", "draft.payment_hold"],
      riskClass: "high",
      examples: [
        "Hold instruction (draft): payment under alert, hold the pending payment until a person has finished the review",
      ],
    },
    {
      id: intent("block_recommendation"),
      description: "Block recommendation for the sanctions officer after two different approvers support a block.",
      capabilities: ["outbox.write", "officer.recommend_block", "approval.require"],
      riskClass: "high",
      examples: ["Block recommendation for the sanctions officer: two different approvers support a block"],
    },
  ],
};

/** The actions a settled decision allows. A pending block allows only its escalation ticket and a payment hold. */
export const ALLOWED: Record<Decision, ActionKind[]> = {
  CLOSE_FALSE_POSITIVE: ["closure_note"],
  ESCALATE_L2: ["escalation_ticket", "hold_instruction"],
  NEED_MORE_INFO: ["rfi_draft"],
  RECOMMEND_BLOCK: ["escalation_ticket", "block_recommendation", "hold_instruction"],
};

/** What the gate recorded for one action: the contract it signed, or why the action was refused. */
export type IntentCheck =
  | { status: "allowed"; intent: string; confidence: number; contract: scoutIntent.ExecutionContract }
  | { status: "refused"; intent: string; reason: string };

export type IntentGate = (body: ActionBody) => IntentCheck;

/** The text Scout reads: the title and the first sentence, before any reason a person typed. */
const textOf = (body: ActionBody): string => `${body.title}: ${body.content.split(/(?<=\.)\s/)[0] ?? ""}`;

export interface IntentGateOptions {
  /** HMAC secret for the contracts; random per process when absent. */
  secret?: string | Buffer;
  now?: () => Date;
}

export function createIntentGate(opts: IntentGateOptions = {}): IntentGate {
  const scout = new scoutIntent.Scout({
    intentRegistry: ACTION_REGISTRY,
    policyPack: "sanctions-desk-actions",
    ...opts,
  });
  return (body) => {
    const decision = scout.decideSync({ prompt: textOf(body), user: { id: "desk", role: "outbox" }, surface: "api" });
    const sensed = decision.executionContract?.intent.primary.id ?? decision.candidates[0]?.intent ?? "GENERAL";
    if (decision.risk.level === "block")
      return { status: "refused", intent: sensed, reason: "the action text carries instructions aimed at the desk" };
    if (!decision.executionContract || sensed !== intent(body.kind))
      return { status: "refused", intent: sensed, reason: `the text reads as ${sensed}, not ${intent(body.kind)}` };
    if (!ALLOWED[body.final].includes(body.kind))
      return { status: "refused", intent: sensed, reason: `a ${body.kind} does not follow a ${body.final} decision` };
    return {
      status: "allowed",
      intent: sensed,
      confidence: decision.executionContract.intent.confidence,
      contract: decision.executionContract,
    };
  };
}

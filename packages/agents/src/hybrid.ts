import type { Decision } from "@sanctions-desk/shared";
import { renderEvidence } from "./decision.js";
import type { EvidenceBundle } from "./evidence.js";
import type { MatchResult } from "./matching.js";
import { chooseDecision, type Evidence } from "./sample-rules.js";

/**
 * The hybrid. Code gives a first finding from the structured fields alone: the approved definitions, identifiers,
 * data-quality rules and the ownership engine. Then the review takes one of two paths:
 *
 *   confirm   the structured evidence settles the case and there is no free text to weigh. The agents confirm the
 *             finding and explain it briefly (the fast path: a short analysis, no long reasoning).
 *   reason    the structured evidence does not settle it, or free text (a customer note, a payment reference, or text
 *             that tries to instruct the reviewer) may change the answer. The agents reason over all the evidence,
 *             with the critic and, for a close, the challenger.
 *
 * The path is recorded for every case so that accuracy, cost and time can be reported for each.
 */

export type ReviewPath = "confirm" | "reason";

export interface FirstFinding {
  decision: Decision;
  /** What decided it, in the words of the deterministic rules. */
  basis: string;
  /** True when the approved definitions or the code's own checks decide it, with nothing left open. */
  settled: boolean;
  /** Free text on the case that code did not weigh. */
  free_text: string[];
  path: ReviewPath;
  /** Why the case took this path. */
  why: string;
}

const present = (v: string | null | undefined): boolean => typeof v === "string" && v.trim() !== "";

export function firstFinding(evidence: EvidenceBundle, match: MatchResult): FirstFinding {
  const pick = chooseDecision(JSON.parse(renderEvidence(evidence, match)) as Evidence);
  const freeText: string[] = [];
  if (present(evidence.customer.notes)) freeText.push("a note on the customer record");
  if (present(evidence.payment?.payment_reference)) freeText.push("the payment reference");
  if (evidence.safety?.violation) freeText.push("text in the data that tries to instruct the reviewer");

  const settled = pick.settled;
  const path: ReviewPath = settled && freeText.length === 0 ? "confirm" : "reason";
  const why =
    path === "confirm"
      ? `the structured evidence settles it (${pick.why})`
      : !settled
        ? `the structured evidence does not settle it (${pick.why})`
        : `the structured evidence points to ${pick.decision}, but there is free text to weigh: ${freeText.join(", ")}`;
  return {
    decision: pick.decision as Decision,
    basis: pick.why,
    settled,
    free_text: freeText,
    path,
    why,
  };
}

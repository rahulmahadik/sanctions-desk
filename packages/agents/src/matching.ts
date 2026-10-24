import {
  type CustomerProfile,
  compareParty,
  customerProfileFromRows,
  type ListedParty,
  listedPartyFromRows,
  type PartyComparison,
} from "@sanctions-desk/data";
import type { EvidenceBundle } from "./evidence.js";
import { documentaryDateOfBirth } from "./evidence-standard.js";
import { closeBlockers } from "./policy-guard.js";
import { screenerDateOfBirth } from "./screener.js";
import type { AgentDeps } from "./types.js";

/** The Matching agent compares the customer with the listed party field by field. No model is involved. */

export interface MatchResult {
  customer: CustomerProfile;
  party: ListedParty;
  comparison: PartyComparison;
  /**
   * Set when the customer has no date of birth on record and a documentary note states one. It is always shown as
   * coming from the note, with the note's check reference, and never as a value of the customer record.
   */
  documentaryDateOfBirth?: string;
  documentaryCheckReference?: string;
  /** Why the policy guard would refuse a close whatever the comparison says (worked out by code; empty when none). */
  closeBlockers?: string[];
}

/** The listed party behind an alert, built from the rows read through Zetaris. */
export function partyOf(evidence: EvidenceBundle): ListedParty {
  return listedPartyFromRows({
    entry: evidence.entry,
    aliases: evidence.aliases,
    dobs: evidence.dobs,
    countries: evidence.countries,
    identifiers: evidence.listIdentifiers,
  });
}

/**
 * The approved definition of a false positive, as the rest of the review must read it: not met when the policy guard
 * would refuse a close anyway (a blocking risk signal, an unread text, instruction-like text, a failing data-quality
 * rule a verified note does not answer). Worked out once, here, so the decision prompt, the first finding and the
 * critic all agree with the guard.
 */
function withCloseBlockers(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  comparison: PartyComparison,
  documentaryDob: boolean,
): PartyComparison {
  if (!comparison.definitions.false_positive) return comparison;
  const blockers = closeBlockers(deps.policy, evidence, documentaryDob);
  if (blockers.length === 0) return comparison;
  return {
    ...comparison,
    definitions: { ...comparison.definitions, false_positive: false },
    reasons: [...comparison.reasons, `false positive not met: ${blockers.join("; ")}`],
  };
}

/**
 * The date of birth a note supplies. A note counts as evidence of the birth date only when it meets the documentary
 * standard; a claim never does. The date comes from the code's own reading of the note or from the screener's, which
 * code has checked against the text and the same standard. A note whose document number is not on the customer
 * record, or could not be checked, supplies nothing.
 */
function noteDateOfBirth(deps: AgentDeps, evidence: EvidenceBundle): { value: string; checkReference: string } | null {
  if (evidence.noteDocument !== undefined && evidence.noteDocument.status !== "on_record") return null;
  return (
    documentaryDateOfBirth(evidence.customer.notes, deps.policy.evidenceStandard) ??
    screenerDateOfBirth(evidence.screener) ??
    null
  );
}

export function matchEvidence(deps: AgentDeps, evidence: EvidenceBundle): MatchResult {
  const recorded = customerProfileFromRows(evidence.customer, evidence.customerIdentifiers);
  const fromNote = recorded.dateOfBirth ? null : noteDateOfBirth(deps, evidence);
  const payer = fromNote ? { ...recorded, dateOfBirth: fromNote.value } : recorded;
  const party = partyOf(evidence);
  // A payment alert is about the other party on the payment, not about the customer who sends it.
  const customer = evidence.payment
    ? {
        ...payer,
        kind: party.kind === "individual" ? ("individual" as const) : ("company" as const),
        name: evidence.payment.counterparty_name ?? "",
        otherNames: [],
        dateOfBirth: null,
        nationality: null,
        residence: evidence.payment.counterparty_country ?? null,
        identifiers: [],
      }
    : payer;
  const compared = compareParty(
    customer,
    party,
    { nameSimilarity: deps.policy.matching.nameSimilarityThreshold },
    {
      identifierMatches: evidence.payment ? [] : evidence.identifierOverlap,
      ...(evidence.payment ? { payment: { country: evidence.payment.counterparty_country ?? null } } : {}),
    },
  );
  const documentaryDob = fromNote !== null && !evidence.payment;
  const comparison = withCloseBlockers(deps, evidence, compared, documentaryDob);
  deps.trace.log({
    agent: "matching",
    action: "compare_party",
    status: "ok",
    confidence: comparison.name.score,
    input_summary: `${customer.customerId} vs ${party.entryId}`,
    output_summary: `${comparison.assessment}: ${comparison.reasons.join("; ")}${fromNote && !evidence.payment ? `; date of birth from verified note (check ref ${fromNote.checkReference})` : ""}`,
    detail: {
      dob: comparison.dob.status,
      country: comparison.country.status,
      identifiers: comparison.identifiers.status,
    },
  });
  return {
    customer,
    party,
    comparison,
    closeBlockers: closeBlockers(deps.policy, evidence, documentaryDob),
    ...(fromNote && !evidence.payment
      ? { documentaryDateOfBirth: fromNote.value, documentaryCheckReference: fromNote.checkReference }
      : {}),
  };
}

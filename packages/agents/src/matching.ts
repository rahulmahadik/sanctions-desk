import {
  type CustomerProfile,
  compareParty,
  customerProfileFromRows,
  type ListedParty,
  listedPartyFromRows,
  type PartyComparison,
} from "@sanctions-desk/data";
import type { EvidenceBundle } from "./evidence.js";
import type { AgentDeps } from "./types.js";

/** The Matching agent compares the customer with the listed party field by field. No model is involved. */

export interface MatchResult {
  customer: CustomerProfile;
  party: ListedParty;
  comparison: PartyComparison;
}

export function matchEvidence(deps: AgentDeps, evidence: EvidenceBundle): MatchResult {
  const payer = customerProfileFromRows(evidence.customer, evidence.customerIdentifiers);
  const party = listedPartyFromRows({
    entry: evidence.entry,
    aliases: evidence.aliases,
    dobs: evidence.dobs,
    countries: evidence.countries,
    identifiers: evidence.listIdentifiers,
  });
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
  const comparison = compareParty(
    customer,
    party,
    { nameSimilarity: deps.policy.matching.nameSimilarityThreshold },
    {
      identifierMatches: evidence.payment ? [] : evidence.identifierOverlap,
      ...(evidence.payment ? { payment: { country: evidence.payment.counterparty_country ?? null } } : {}),
    },
  );
  deps.trace.log({
    agent: "matching",
    action: "compare_party",
    status: "ok",
    confidence: comparison.name.score,
    input_summary: `${customer.customerId} vs ${party.entryId}`,
    output_summary: `${comparison.assessment}: ${comparison.reasons.join("; ")}`,
    detail: {
      dob: comparison.dob.status,
      country: comparison.country.status,
      identifiers: comparison.identifiers.status,
    },
  });
  return { customer, party, comparison };
}

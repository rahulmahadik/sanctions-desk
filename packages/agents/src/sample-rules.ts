import type { GenerateRequest } from "@sanctions-desk/shared";

/**
 * The labelled fallback "model" used by sample mode. It answers the Decision and Critic prompts with plain
 * rules over the evidence in the prompt, so a review can run with no model service at all. The agents,
 * the semantic-layer reads, the fact checks and the policy guard around it are the real ones.
 */

interface Evidence {
  customer?: { customer_id?: string; full_name?: string; date_of_birth?: string | null };
  payment?: { payment_id?: string; counterparty_name?: string };
  list_entry?: { entry_id?: string; primary_name?: string };
  list_dob?: Array<{ dob_id?: string; dob_value?: string | null }>;
  data_quality?: Array<{ failed?: boolean }>;
  comparison?: {
    assessment?: string;
    date_of_birth?: string;
    nationality?: { status?: string };
    identifiers?: string;
    definitions_met?: { true_match?: boolean; false_positive?: boolean; counterparty_match?: boolean };
    assessment_note?: string;
  };
}

function evidenceOf(prompt: string): Evidence {
  const match = /<evidence>([\s\S]*?)<\/evidence>/.exec(prompt);
  if (!match) return {};
  try {
    return JSON.parse(match[1] as string) as Evidence;
  } catch {
    return {};
  }
}

function chooseDecision(e: Evidence): { decision: string; confidence: number; why: string } {
  const c = e.comparison ?? {};
  const met = c.definitions_met ?? {};
  if (met.true_match || met.counterparty_match || c.identifiers === "match" || c.assessment === "strong") {
    return {
      decision: "ESCALATE_L2",
      confidence: 0.85,
      why: "an approved match definition is met, or a document number agrees with the listed party",
    };
  }
  if (e.data_quality?.some((d) => d.failed)) {
    return {
      decision: "NEED_MORE_INFO",
      confidence: 0.7,
      why: "the record fails a data-quality rule, so the data cannot be relied on yet",
    };
  }
  if (met.false_positive) {
    return {
      decision: "CLOSE_FALSE_POSITIVE",
      confidence: 0.85,
      why: "the approved definition of a false positive is met and no identifier matches",
    };
  }
  if (c.date_of_birth === "missing_customer") {
    return {
      decision: "NEED_MORE_INFO",
      confidence: 0.7,
      why: "the customer has no date of birth on file, so the match can be neither confirmed nor ruled out",
    };
  }
  return { decision: "ESCALATE_L2", confidence: 0.7, why: "the match cannot be ruled out with the data available" };
}

function decisionAnswer(e: Evidence): string {
  const pick = chooseDecision(e);
  const facts: Array<Record<string, string | null>> = [];
  if (e.customer?.customer_id) {
    facts.push({
      table: "customer",
      key_value: e.customer.customer_id,
      column: "full_name",
      value: e.customer.full_name ?? null,
    });
    facts.push({
      table: "customer",
      key_value: e.customer.customer_id,
      column: "date_of_birth",
      value: e.customer.date_of_birth ?? null,
    });
  }
  if (e.list_entry?.entry_id) {
    facts.push({
      table: "list_entry",
      key_value: e.list_entry.entry_id,
      column: "primary_name",
      value: e.list_entry.primary_name ?? null,
    });
  }
  if (e.payment?.payment_id) {
    facts.push({
      table: "payment",
      key_value: e.payment.payment_id,
      column: "counterparty_name",
      value: e.payment.counterparty_name ?? null,
    });
  }
  const listedDob = e.list_dob?.find((d) => d.dob_id && d.dob_value);
  if (listedDob?.dob_id) {
    facts.push({
      table: "list_dob",
      key_value: listedDob.dob_id,
      column: "dob_value",
      value: listedDob.dob_value ?? null,
    });
  }
  const comparison = e.comparison;
  return JSON.stringify({
    decision: pick.decision,
    confidence: pick.confidence,
    rationale: `Rules-based sample answer: ${pick.why}. Name is ${comparison?.assessment ?? "unrated"}, date of birth is ${comparison?.date_of_birth ?? "unknown"}, nationality is ${comparison?.nationality?.status ?? "unknown"}.`,
    facts,
    what_would_change: [
      "A date of birth or document number that settles whether this is the listed party",
      "A change in the listed entry on the next list update",
    ],
  });
}

/** The labelled rules used when SAMPLE_MODE is on and no model service answers. */
export function sampleRules(req: GenerateRequest): string {
  const evidence = evidenceOf(req.prompt);
  if (req.prompt.startsWith("TASK: critic")) return JSON.stringify({ verdict: "approve", issues: [] });
  return decisionAnswer(evidence);
}

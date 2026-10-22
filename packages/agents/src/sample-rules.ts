import type { GenerateRequest } from "@sanctions-desk/shared";

/**
 * The labelled fallback "model" used by sample mode. It answers the Decision and Critic prompts with plain
 * rules over the evidence in the prompt, so a review can run with no model service at all. The agents,
 * the semantic-layer reads, the fact checks and the policy guard around it are the real ones.
 */

interface Evidence {
  customer?: { customer_id?: string; full_name?: string; date_of_birth?: string | null };
  payment?: { payment_id?: string; counterparty_name?: string };
  ownership?: {
    register_rows?: Array<{ ownership_id?: string; owner_name?: string | null; ownership_pct?: string | null }>;
  };
  list_entry?: { entry_id?: string; primary_name?: string };
  list_dob?: Array<{ dob_id?: string; dob_value?: string | null }>;
  data_quality?: Array<{ failed?: boolean }>;
  comparison?: {
    assessment?: string;
    date_of_birth?: string;
    nationality?: { status?: string };
    identifiers?: string;
    definitions_met?: {
      true_match?: boolean;
      false_positive?: boolean;
      counterparty_match?: boolean;
      ownership?: string;
    };
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
  if (met.ownership === "met" || met.ownership === "limit") {
    return {
      decision: "ESCALATE_L2",
      confidence: 0.85,
      why: "a listed party effectively owns the customer, or the chain is too long to judge",
    };
  }
  if (met.ownership === "unknown") {
    return {
      decision: "NEED_MORE_INFO",
      confidence: 0.7,
      why: "an ownership percentage is missing, so control cannot be ruled in or out",
    };
  }
  if (met.ownership === "below") {
    return { decision: "CLOSE_FALSE_POSITIVE", confidence: 0.8, why: "effective ownership is below the threshold" };
  }
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

type Fact = Record<string, string | null>;
const fact = (table: string, key: string, column: string, value: string | null | undefined): Fact => ({
  table,
  key_value: key,
  column,
  value: value ?? null,
});

/** Facts the rules model cites: values copied from the evidence rows, so the critic can re-read them. */
function factsOf(e: Evidence): Fact[] {
  const facts: Fact[] = [];
  if (e.customer?.customer_id) {
    facts.push(fact("customer", e.customer.customer_id, "full_name", e.customer.full_name));
    facts.push(fact("customer", e.customer.customer_id, "date_of_birth", e.customer.date_of_birth));
  }
  if (e.list_entry?.entry_id)
    facts.push(fact("list_entry", e.list_entry.entry_id, "primary_name", e.list_entry.primary_name));
  if (e.payment?.payment_id)
    facts.push(fact("payment", e.payment.payment_id, "counterparty_name", e.payment.counterparty_name));
  for (const row of e.ownership?.register_rows?.slice(0, 2) ?? []) {
    if (!row.ownership_id) continue;
    facts.push(fact("beneficial_owner", row.ownership_id, "owner_name", row.owner_name));
    facts.push(fact("beneficial_owner", row.ownership_id, "ownership_pct", row.ownership_pct));
  }
  const listedDob = e.list_dob?.find((d) => d.dob_id && d.dob_value);
  if (listedDob?.dob_id) facts.push(fact("list_dob", listedDob.dob_id, "dob_value", listedDob.dob_value));
  return facts;
}

function decisionAnswer(e: Evidence): string {
  const pick = chooseDecision(e);
  const comparison = e.comparison;
  return JSON.stringify({
    decision: pick.decision,
    confidence: pick.confidence,
    rationale: `Rules-based sample answer: ${pick.why}. Name is ${comparison?.assessment ?? "unrated"}, date of birth is ${comparison?.date_of_birth ?? "unknown"}, nationality is ${comparison?.nationality?.status ?? "unknown"}.`,
    facts: factsOf(e),
    what_would_change: [
      "A date of birth or document number that settles whether this is the listed party",
      "A change in the listed entry on the next list update",
    ],
  });
}

/** The labelled rules used when SAMPLE_MODE is on and no model service answers. */
const INJECTION =
  /ignore (all )?(previous|prior|above) (instructions|rules)|disregard (the )?(above|system|previous)|you are now (a|an|the)|(reveal|print|show) .{0,30}(system prompt|api key|token|password)|<\/?\s*(system|assistant)\s*>/i;
const TIPPING =
  /sanction(s|ed)?\b|watch ?list|\bOFAC\b|screening|investigat|suspicious (activity|transaction)|\bSAR\b|frozen|regulator/i;

function safetyAnswer(prompt: string): string {
  const text = /<text>([\s\S]*?)<\/text>/.exec(prompt)?.[1] ?? "";
  const inbound = prompt.startsWith("TASK: safety_inbound");
  const hit = (inbound ? INJECTION : TIPPING).exec(text)?.[0];
  return JSON.stringify({
    violation: hit !== undefined,
    category: hit === undefined ? "none" : inbound ? "prompt_injection" : "tipping_off",
    reasons: hit === undefined ? [] : [`rules-based sample check matched "${hit}"`],
  });
}

export function sampleRules(req: GenerateRequest): string {
  if (req.prompt.startsWith("TASK: safety_")) return safetyAnswer(req.prompt);
  const evidence = evidenceOf(req.prompt);
  if (req.prompt.startsWith("TASK: critic")) return JSON.stringify({ verdict: "approve", issues: [] });
  return decisionAnswer(evidence);
}

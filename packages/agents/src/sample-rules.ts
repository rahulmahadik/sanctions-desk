import type { GenerateRequest } from "@sanctions-desk/shared";
import { INJECTION, screenerAnswer } from "./sample-screener.js";

/**
 * The labelled fallback "model" used by sample mode. It answers the Decision and Critic prompts with plain
 * rules over the evidence in the prompt, so a review can run with no model service at all. The agents,
 * the semantic-layer reads, the fact checks and the policy guard around it are the real ones.
 */

export interface Evidence {
  customer?: { customer_id?: string; full_name?: string; date_of_birth?: string | null };
  payment?: { payment_id?: string; counterparty_name?: string };
  ownership?: {
    register_rows?: Array<{ ownership_id?: string; owner_name?: string | null; ownership_pct?: string | null }>;
  };
  list_entry?: { entry_id?: string; primary_name?: string };
  list_dob?: Array<{ dob_id?: string; dob_value?: string | null }>;
  data_quality?: Array<{ failed?: boolean }>;
  date_of_birth_from_verified_note?: { value?: string; check_reference?: string };
  screener_facts?: {
    status?: string;
    risk_signals?: Array<{ type: string; confidence: number; grounded?: boolean }>;
  };
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
    close_blockers?: string[];
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

export interface Choice {
  decision: string;
  confidence: number;
  why: string;
  /** True when an approved definition, an identifier, a failing rule or the ownership engine decided it. */
  settled: boolean;
}

/**
 * The deterministic finding: the decision the approved definitions and the code's own checks give, with no language
 * model. It is the stand-in model's answer in sample mode and the first finding of every review.
 */
export function chooseDecision(e: Evidence): Choice {
  const pick = structuralChoice(e);
  const blockers = e.comparison?.close_blockers ?? [];
  if (pick.decision !== "CLOSE_FALSE_POSITIVE" || blockers.length === 0) return pick;
  // Never a close the policy guard would refuse: say why instead.
  const onlyDataQuality = blockers.every((b) => b.startsWith("a failing data-quality rule"));
  return {
    decision: onlyDataQuality ? "NEED_MORE_INFO" : "ESCALATE_L2",
    confidence: 0.7,
    why: `a close is not open to this case: ${blockers.join("; ")}`,
    settled: onlyDataQuality,
  };
}

function structuralChoice(e: Evidence): Choice {
  const c = e.comparison ?? {};
  const met = c.definitions_met ?? {};
  if (met.ownership === "met" || met.ownership === "limit") {
    return {
      decision: "ESCALATE_L2",
      confidence: 0.85,
      why: "a listed party effectively owns the customer, or the chain is too long to judge",
      settled: true,
    };
  }
  if (met.ownership === "unknown") {
    return {
      decision: "NEED_MORE_INFO",
      confidence: 0.7,
      why: "an ownership percentage is missing, so control cannot be ruled in or out",
      settled: true,
    };
  }
  if (met.ownership === "below") {
    return {
      decision: "CLOSE_FALSE_POSITIVE",
      confidence: 0.8,
      why: "effective ownership is below the threshold",
      settled: true,
    };
  }
  if (met.true_match || met.counterparty_match || c.identifiers === "match" || c.assessment === "strong") {
    return {
      decision: "ESCALATE_L2",
      confidence: 0.85,
      why: "an approved match definition is met, or a document number agrees with the listed party",
      settled: true,
    };
  }
  // A date of birth from a verified note answers the date-of-birth rule; matching has already withdrawn the false
  // positive when any other rule fails, so the definition comes first here.
  const documentaryClear = met.false_positive === true && e.date_of_birth_from_verified_note !== undefined;
  if (e.data_quality?.some((d) => d.failed) && !documentaryClear) {
    return {
      decision: "NEED_MORE_INFO",
      confidence: 0.7,
      why: "the record fails a data-quality rule, so the data cannot be relied on yet",
      settled: true,
    };
  }
  if (met.false_positive) {
    return {
      decision: "CLOSE_FALSE_POSITIVE",
      confidence: 0.85,
      why: "the approved definition of a false positive is met and no identifier matches",
      settled: true,
    };
  }
  if (c.date_of_birth === "missing_customer") {
    return {
      decision: "NEED_MORE_INFO",
      confidence: 0.7,
      why: "the customer has no date of birth on file, so the match can be neither confirmed nor ruled out",
      settled: false,
    };
  }
  return {
    decision: "ESCALATE_L2",
    confidence: 0.7,
    why: "the match cannot be ruled out with the data available",
    settled: false,
  };
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

/** The screener's risk signals at or above the policy's threshold, grounded or not, as the decision prompt states them. */
function screenerBlocks(e: Evidence, prompt: string): string[] {
  const threshold = Number(/"screener_confidence_threshold":\s*([0-9.]+)/.exec(prompt)?.[1] ?? 0.5);
  return (e.screener_facts?.risk_signals ?? []).filter((s) => s.confidence >= threshold).map((s) => s.type);
}

function decisionAnswer(e: Evidence, prompt = ""): string {
  const base = chooseDecision(e);
  const pick: Choice =
    screenerBlocks(e, prompt).length > 0 || e.screener_facts?.status === "failed"
      ? {
          decision: "ESCALATE_L2",
          confidence: 0.7,
          why: "the screener found a risk signal in the free text, or could not read it",
          settled: false,
        }
      : base;
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
  if (req.prompt.startsWith("TASK: screener")) return screenerAnswer(req.prompt);
  const evidence = evidenceOf(req.prompt);
  if (req.prompt.startsWith("TASK: challenge")) {
    return JSON.stringify({
      credible: false,
      argument: "Rules stand-in: the comparison computed by code shows no conflict-free argument for a true match.",
      points: [],
    });
  }
  if (req.prompt.startsWith("TASK: critic")) return JSON.stringify({ verdict: "approve", issues: [] });
  return decisionAnswer(evidence, req.prompt);
}

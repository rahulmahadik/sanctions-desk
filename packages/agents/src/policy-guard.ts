import type { Decision, GuardVerdictInput, Policy } from "@sanctions-desk/shared";
import type { DecisionOutput } from "./decision.js";
import type { EvidenceBundle } from "./evidence.js";
import { assessNote } from "./evidence-standard.js";
import type { MatchResult } from "./matching.js";

/**
 * The Policy guard applies the hard rules of the active policy. It can make a recommendation more
 * cautious, never less. A person always has the last word, and nothing here sends or blocks anything.
 */

export const CAUTION: Record<Decision, number> = {
  CLOSE_FALSE_POSITIVE: 0,
  NEED_MORE_INFO: 1,
  ESCALATE_L2: 2,
  RECOMMEND_BLOCK: 3,
};

export interface GuardOutcome {
  decision: Decision;
  confidence: number;
  changed: boolean;
  verdicts: GuardVerdictInput[];
  approvalsRequired: number;
}

export interface GuardInput {
  policy: Policy;
  decision: DecisionOutput;
  match: MatchResult;
  evidence: EvidenceBundle;
  /** True when the critic could not approve within the allowed rounds. */
  criticUnresolved: boolean;
}

/** Instructions hidden in data: the policy's patterns, matched case-insensitively. */
export function findInjection(policy: Policy, texts: readonly string[]): string[] {
  const hits: string[] = [];
  for (const pattern of policy.guards.injectionPatterns) {
    const re = new RegExp(pattern, "i");
    for (const text of texts) if (re.test(text)) hits.push(text.slice(0, 80));
  }
  return [...new Set(hits)];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where the case touches a watched jurisdiction: the customer's own countries, every country on the payment's
 * route (the other party, the beneficiary's bank, an intermediary bank), and place names in the free-text
 * reference. The listed party's countries say nothing about where the customer is exposed.
 */
function jurisdictionHits(policy: Policy, evidence: EvidenceBundle): string[] {
  const watched = policy.jurisdictions.filter((j) => j.action === "escalate");
  const codes = new Set(watched.map((j) => j.country));
  const payment = evidence.payment;
  const where: Array<[string, string | null | undefined]> = [
    ["customer nationality", evidence.customer.nationality],
    ["customer residence", evidence.customer.residence_country],
    ["payment counterparty", payment?.counterparty_country],
    ["beneficiary bank", payment?.beneficiary_bank_country],
    ["intermediary bank", payment?.intermediary_bank_country],
  ];
  const hits = where
    .filter((w): w is [string, string] => typeof w[1] === "string" && codes.has(w[1]))
    .map(([role, country]) => `${country} (${role})`);
  const reference = payment?.payment_reference;
  if (typeof reference === "string") {
    for (const j of watched) {
      const mention = j.keywords.find((k) => new RegExp(`\\b${escapeRegExp(k)}\\b`, "i").test(reference));
      if (mention) hits.push(`${j.country} (payment reference mentions "${mention}")`);
    }
  }
  return [...new Set(hits)];
}

/** What one rule found. A rule that fails names the least cautious decision it still accepts. */
interface Finding {
  guard: string;
  detail: string;
  /** Present when the rule fails: the decision the recommendation is raised to. */
  raiseTo?: Decision;
  /** A flag is recorded but does not change the decision on its own. */
  flag?: boolean;
  /** Only for the block-needs-backing rules: a block that fails these goes to a person as an escalation. */
  unbacksBlock?: boolean;
}

interface Context extends GuardInput {
  closing: boolean;
}

const fails = (guard: string, raiseTo: Decision, detail: string, extra: Partial<Finding> = {}): Finding => ({
  guard,
  detail,
  raiseTo,
  ...extra,
});
const passes = (guard: string, detail: string): Finding => ({ guard, detail });

type Rule = (c: Context) => Finding | Finding[];

const definitionRule: Rule = ({ evidence }) => {
  const mismatched = evidence.definitionCheck.mismatched;
  return mismatched.length > 0
    ? fails(
        "definition_version",
        "NEED_MORE_INFO",
        `approved wording changed for ${mismatched.map((m) => m.definition_id).join(", ")}; the matching rules need review`,
      )
    : passes(
        "definition_version",
        evidence.definitionCheck.applied.map((d) => `${d.definition_id}@${d.version}`).join(", "),
      );
};

/**
 * A customer record that fails a data-quality rule can never support a close. The one narrow exception: the rule that
 * wants a date of birth on an individual's record, when a verified note (a check reference, a document number and a
 * date) supplies the date. The finding stays in the record and is shown as a flag, and the date is always labelled as
 * coming from the note.
 */
const DOB_RULE = "dob_present_for_individuals";

const dataQualityRule: Rule = ({ policy, evidence, match }) => {
  const failed = evidence.dq.filter((d) => d.failed);
  const suppliedByNote = match.documentaryDateOfBirth !== undefined;
  const blocking = failed.filter((d) => !(suppliedByNote && d.rule === DOB_RULE));
  if (failed.length > 0 && blocking.length === 0 && suppliedByNote) {
    return {
      guard: "data_quality",
      detail: `customer record fails ${DOB_RULE}; the date of birth comes from a verified note (check ref ${match.documentaryCheckReference}), not from the record`,
      flag: true,
    };
  }
  return blocking.length > 0 && policy.critic.abstainOnInvalidData
    ? fails("data_quality", "NEED_MORE_INFO", `customer record fails ${blocking.map((d) => d.rule).join(", ")}`)
    : passes("data_quality", "no failing data-quality rule on the customer record");
};

const closeRules: Rule = ({ closing, match, policy, decision }) => {
  const c = match.comparison;
  if (!closing) {
    return [
      passes("strong_match", `comparison rates the match as ${c.assessment}`),
      passes(
        "identifier_match",
        c.identifiers.status === "match" ? "identifier matches; not closing" : "no identifier match",
      ),
      passes("missing_data", `date of birth: ${c.dob.status}`),
      passes("possible_match", "no unresolved possible match"),
      passes("confidence_floor", `confidence ${decision.confidence}`),
    ];
  }
  const out: Finding[] = [];
  out.push(
    c.assessment === "strong"
      ? fails("strong_match", "ESCALATE_L2", "a strong match cannot be closed")
      : passes("strong_match", `comparison rates the match as ${c.assessment}`),
  );
  out.push(
    c.identifiers.status === "match"
      ? fails("identifier_match", "ESCALATE_L2", "an identifier matches the listed party")
      : passes("identifier_match", "no identifier match"),
  );
  out.push(
    c.subject === "customer" &&
      c.dob.status === "missing_customer" &&
      c.name.score >= policy.matching.nameSimilarityThreshold
      ? fails("missing_data", "NEED_MORE_INFO", "the customer has no date of birth and the name matches")
      : passes("missing_data", `date of birth: ${c.dob.status}`),
  );
  out.push(
    c.assessment === "possible"
      ? fails("possible_match", "ESCALATE_L2", "the match cannot be ruled out")
      : passes("possible_match", "no unresolved possible match"),
  );
  out.push(
    decision.confidence < policy.critic.confidenceFloorForClose
      ? fails(
          "confidence_floor",
          "ESCALATE_L2",
          `confidence ${decision.confidence} is below ${policy.critic.confidenceFloorForClose}`,
        )
      : passes("confidence_floor", `confidence ${decision.confidence}`),
  );
  if (!policy.automation.autoClose) {
    out.push(fails("close_not_allowed", "ESCALATE_L2", "the active policy does not allow close recommendations"));
  }
  return out;
};

/**
 * A close may rest on free text only when the text meets the documentary standard of the active policy. The text is
 * read from the evidence rows, not from the model's quotation of it.
 */
const evidenceStandardRule: Rule = ({ closing, policy, decision, evidence, match }) => {
  const standard = policy.evidenceStandard;
  const cited = (table: string, column: string) =>
    decision.facts.some((f) => f.table.toLowerCase() === table && f.column.toLowerCase() === column);
  const relied: Array<{ label: string; missing: string[] }> = [];
  if (cited("customer", "notes") || match.documentaryDateOfBirth)
    relied.push({ label: "customer note", missing: assessNote({ text: evidence.customer.notes }, standard).missing });
  if (evidence.payment && cited("payment", "payment_reference"))
    relied.push({
      label: "payment reference",
      missing: assessNote(
        {
          text: evidence.payment.payment_reference,
          payment: { counterpartyName: evidence.payment.counterparty_name },
        },
        standard,
      ).missing,
    });
  const [definitionId, definitionVersion] = standard.definition.split("@");
  const stated = evidence.definitionCheck.applied.some(
    (d) => d.definition_id === definitionId && d.version === definitionVersion,
  );
  if (closing && !stated)
    return fails(
      "evidence_standard",
      "NEED_MORE_INFO",
      `the policy relies on the approved definition ${standard.definition}, which the semantic layer does not hold as the newest approved version`,
    );
  if (!closing || relied.length === 0)
    return passes("evidence_standard", closing ? "no free text relied on" : "not closing");
  const claims = relied.filter((r) => r.missing.length > 0);
  return claims.length > 0
    ? fails(
        "evidence_standard",
        "NEED_MORE_INFO",
        `the ${claims.map((c) => `${c.label} lacks ${c.missing.join(", ")}`).join("; ")}: a claim, not documentary evidence (policy version ${policy.version})`,
      )
    : passes("evidence_standard", `${relied.map((r) => r.label).join(" and ")} meets the documentary standard`);
};

const underReactionRule: Rule = ({ decision, match }) =>
  match.comparison.definitions.true_match && decision.decision === "NEED_MORE_INFO"
    ? fails("true_match_met", "ESCALATE_L2", "the approved definition of a true match is met; it goes to a person")
    : passes(
        "true_match_met",
        match.comparison.definitions.true_match ? "true match: escalated" : "true match definition not met",
      );

const ownershipRule: Rule = ({ decision, match, policy }) => {
  const status = match.comparison.definitions.ownership;
  if (status === undefined) return passes("ownership", "not an ownership alert");
  if (status === "met")
    return fails("ownership", "ESCALATE_L2", "a listed party effectively owns the customer at or above the threshold");
  if (status === "limit") {
    const to: Decision = policy.ownership.onLimitReached === "escalate" ? "ESCALATE_L2" : "NEED_MORE_INFO";
    return fails("ownership", to, "the ownership chain is longer than the policy allows");
  }
  if (status === "unknown") return fails("ownership", "NEED_MORE_INFO", "an ownership percentage is missing");
  return passes("ownership", `effective ownership is below the threshold (${decision.decision})`);
};

const jurisdictionRule: Rule = ({ closing, policy, evidence }) => {
  const countries = jurisdictionHits(policy, evidence);
  if (closing && countries.length > 0)
    return fails("jurisdiction", "ESCALATE_L2", `watched jurisdiction: ${countries.join(", ")}`);
  return passes(
    "jurisdiction",
    countries.length > 0 ? `watched jurisdiction ${countries.join(", ")}; not closing` : "no watched jurisdiction",
  );
};

const injectionRule: Rule = ({ closing, policy, evidence }) => {
  if (findInjection(policy, evidence.freeText).length === 0)
    return passes("injection", "no instruction-like text in the data");
  const detail = closing
    ? "instruction-like text in the data; no automatic close"
    : "instruction-like text found in the data; ignored as data";
  return closing ? fails("injection", "ESCALATE_L2", detail) : { guard: "injection", detail, flag: true };
};

const blockRules: Rule = ({ decision, match, criticUnresolved }) => {
  const out: Finding[] = [];
  if (decision.decision === "RECOMMEND_BLOCK" && match.comparison.assessment !== "strong") {
    out.push(
      fails("block_needs_strong_match", "ESCALATE_L2", "a block recommendation needs a strong match", {
        unbacksBlock: true,
      }),
    );
  }
  if (criticUnresolved) {
    out.push(
      fails("critic_unresolved", "ESCALATE_L2", "the critic could not approve within the allowed rounds", {
        unbacksBlock: true,
      }),
    );
  }
  return out;
};

const RULES: readonly Rule[] = [
  definitionRule,
  dataQualityRule,
  closeRules,
  evidenceStandardRule,
  underReactionRule,
  ownershipRule,
  jurisdictionRule,
  injectionRule,
  blockRules,
];

export function applyPolicyGuard(input: GuardInput): GuardOutcome {
  const context: Context = { ...input, closing: input.decision.decision === "CLOSE_FALSE_POSITIVE" };
  const findings = RULES.flatMap((rule) => [rule(context)].flat());

  let final = input.decision.decision;
  for (const f of findings) if (f.raiseTo && CAUTION[f.raiseTo] > CAUTION[final]) final = f.raiseTo;
  // A block recommendation that was not backed up (weak evidence, or the critic never approved) goes to a person as an escalation.
  if (final === "RECOMMEND_BLOCK" && findings.some((f) => f.unbacksBlock)) final = "ESCALATE_L2";

  const verdicts: GuardVerdictInput[] = findings.map((f) => ({
    guard: f.guard,
    verdict: f.raiseTo ? "block" : f.flag ? "flag" : "pass",
    detail: f.detail,
  }));
  verdicts.push({
    guard: "human_in_the_loop",
    verdict: "pass",
    detail: "recommendation only; a person decides and nothing is sent or blocked automatically",
  });

  const changed = final !== input.decision.decision;
  return {
    decision: final,
    confidence: changed ? Math.min(input.decision.confidence, 0.6) : input.decision.confidence,
    changed,
    verdicts,
    approvalsRequired: final === "RECOMMEND_BLOCK" ? input.policy.automation.blockApprovalsRequired : 1,
  };
}

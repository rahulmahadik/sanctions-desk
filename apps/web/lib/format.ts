import type { CloseStopView, Decision, Row, StoppedBy } from "./types";

export const DECISION_LABEL: Record<Decision, string> = {
  CLOSE_FALSE_POSITIVE: "Close as false positive",
  ESCALATE_L2: "Escalate to level 2",
  RECOMMEND_BLOCK: "Recommend block (two approvals)",
  NEED_MORE_INFO: "Need more information",
};

/** The one palette for outcomes: block red, escalate amber, need more information blue, close green. */
export const DECISION_TONE: Record<Decision, "block" | "escalate" | "info" | "close"> = {
  CLOSE_FALSE_POSITIVE: "close",
  ESCALATE_L2: "escalate",
  RECOMMEND_BLOCK: "block",
  NEED_MORE_INFO: "info",
};

/** The icon beside each outcome's words, so colour is never the only signal. */
export const DECISION_ICON: Record<Decision, string> = {
  CLOSE_FALSE_POSITIVE: "✓",
  ESCALATE_L2: "▲",
  RECOMMEND_BLOCK: "⊘",
  NEED_MORE_INFO: "?",
};

/**
 * The reason a person gives with a decision, in characters. The rule lives in the human decision step
 * (packages/agents/src/human-decision.ts: MIN_REASON_LENGTH and MAX_REASON_LENGTH), which the interface cannot
 * import; a test keeps the two equal. Every screen reads this constant, none writes the numbers out again.
 */
export const REASON_LENGTH = { min: 10, max: 600 } as const;

export const MASK = "••••";

/** What to show for a field. A masked column is always drawn as dots, whatever the API sent. */
export function show(row: Row | null | undefined, column: string, masked: readonly string[] = []): string {
  if (masked.includes(column)) return MASK;
  const value = row?.[column];
  return value === null || value === undefined || value === "" ? "—" : value;
}

export const percent = (n: number): string => `${Math.round(n * 100)}%`;
export const seconds = (ms: number | undefined): string => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
export const money = (n: number, currency = "USD"): string =>
  `${n < 0.01 && n > 0 ? "<0.01" : n.toFixed(2)} ${currency}`;

export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : "—";
}

/** A short name for a model id. */
export function modelName(model: string): string {
  if (/ultra/i.test(model)) return "Nemotron 3 Ultra 550B";
  if (/lightning/i.test(model)) return "Nemotron 3.5 Lightning 30B";
  if (model === "fallback-rules") return "Rules stand-in (sample mode)";
  return model;
}

export const label = (text: string): string => text.replaceAll("_", " ");

/** The one sentence on who decides, as the README and the docs say it. */
export const FINAL_CALL = "A person makes the final call; automatic closing is off by default.";

/**
 * Plain words for the codes the comparison and the checks use. The sealed record keeps the codes; only the screen
 * says them in words. A code that is not listed is shown with its underscores as spaces.
 */
const DOB_WORDS: Record<string, string> = {
  exact: "the same date",
  compatible: "compatible (not ruled out)",
  conflict: "conflicts",
  missing_customer: "customer has no date of birth on record",
  missing_list: "the list gives no date of birth",
};
/** On a payment the compared party is the counterparty, and a payment carries no date of birth. */
const PAYMENT_DOB_WORDS: Record<string, string> = {
  ...DOB_WORDS,
  missing_customer: "the payment gives no date of birth for the counterparty",
};
const COUNTRY_WORDS: Record<string, string> = {
  match: "matches",
  address_only: "only an address matches",
  conflict: "conflicts",
  unknown: "not known",
};
const NAME_METHOD_WORDS: Record<string, string> = {
  exact: "exact",
  token_set: "same words",
  phonetic: "sounds alike",
  none: "no match",
};
const ASSESSMENT_WORDS: Record<string, string> = {
  strong: "strong",
  possible: "possible",
  weak: "weak",
};
export const VERDICT_WORDS: Record<string, string> = {
  pass: "passed",
  flag: "flagged (noted; it did not change the outcome)",
  block: "stopped it",
  fail: "failed",
  approved: "approved",
  rejected: "sent back",
  escalated: "escalated",
  not_run: "did not run",
};
export const GUARD_WORDS: Record<string, string> = {
  definition_version: "approved definitions",
  data_quality: "data quality",
  strong_match: "strong match",
  identifier_match: "identifier match",
  missing_data: "missing data",
  possible_match: "possible match",
  confidence_floor: "lowest confidence for a close",
  evidence_standard: "evidence standard for notes",
  screener: "free-text screener",
  screener_grounding: "screener signals found in the text",
  screener_locality: "screener ran on this machine",
  guard_locality: "safety guard ran on this machine",
  true_match_met: "true-match definition",
  ownership: "ownership",
  jurisdiction: "watched jurisdiction",
  injection: "instructions hidden in the data",
  human_in_the_loop: "a person makes the final call",
  challenger: "challenger",
  model_decision: "model answer",
  critic_unresolved: "critic could not approve",
  block_needs_strong_match: "a block needs a strong match",
  close_not_allowed: "close not allowed",
};

const wordsFor = (map: Record<string, string>, code: string): string => map[code] ?? label(code);
export const verdictWords = (code: string): string => wordsFor(VERDICT_WORDS, code);
export const guardWords = (code: string): string => wordsFor(GUARD_WORDS, code);

/** Which kind of check a guard belongs to, as the API's close-stop reading groups them (close-stop.ts). */
export function guardStoppedBy(guard: string): StoppedBy {
  if (guard.startsWith("screener")) return "screener";
  if (guard === "data_quality" || guard === "missing_data") return "data quality";
  if (guard === "critic_unresolved") return "critic";
  return "policy guard";
}

/**
 * Whether this check stopped a close the decision step proposed, from the run's close-stop reading: the check is
 * named in its reasons, or it is a screener, data-quality or critic check and that kind of check stopped the close.
 * The policy guard holds many unrelated rules, so one of them is only counted when it is named.
 */
export function checkStoppedClose(guard: string, stop: CloseStopView | null | undefined): boolean {
  if (!stop?.stopped) return false;
  const named = `${guard.replaceAll("_", " ")}:`;
  if (stop.reasons.some((r) => r.startsWith(named))) return true;
  const kind = guardStoppedBy(guard);
  return kind !== "policy guard" && stop.by.includes(kind);
}

/**
 * A check's verdict in words. A flag is normally a note that did not change the outcome; a flag on a check that
 * stopped a close says so instead, so the list agrees with the run graph.
 */
export function checkVerdictWords(guard: string, verdict: string, stop?: CloseStopView | null): string {
  if (verdict === "flag" && checkStoppedClose(guard, stop)) return "flagged — stopped a close";
  return verdictWords(verdict);
}

/**
 * A comparison reason or a rationale, with its codes in plain words and the compared name labelled: on a payment
 * alert the name compared is the payment counterparty's, on any other alert the customer's. The text stored in the
 * sealed record is unchanged; this is only how the screen says it.
 */
export function plainReason(text: string, alertType?: string | null): string {
  const payment = alertType === "payment";
  const who = payment ? "payment counterparty name" : "customer name";
  const dob = payment ? PAYMENT_DOB_WORDS : DOB_WORDS;
  return (
    text
      // name 1.00 (exact) vs primary "X"
      .replace(
        /\bname (\d(?:\.\d+)?) \((\w+)\) vs (\w+) "/g,
        (_m, score: string, method: string, alias: string) =>
          `${who}: ${score} ${wordsFor(NAME_METHOD_WORDS, method)}, against the listed ${label(alias)} name "`,
      )
      // the stand-in's "Name is weak": that is the whole comparison, not the name
      .replace(
        /\bName is (\w+)/g,
        (_m, a: string) => `Overall match (all facts together) is ${wordsFor(ASSESSMENT_WORDS, a)}`,
      )
      .replace(/\bdate of birth(?::| is) (\w+)/g, (_m, code: string) => `date of birth: ${wordsFor(dob, code)}`)
      .replace(
        /\b(country|nationality)(?::| is) (\w+)/g,
        (_m, what: string, code: string) =>
          `${payment && what === "country" ? "counterparty country" : what}: ${wordsFor(COUNTRY_WORDS, code)}`,
      )
  );
}

/** Role names as people read them. The ids stay as the API and the sealed record use them. */
export const ROLE_LABEL: Record<string, string> = {
  analyst: "Analyst (L1)",
  approver: "Approver (L2 senior reviewer)",
  policy_admin: "Policy admin",
  viewer: "Viewer",
};

export const roleLabel = (role: string | undefined): string => (role ? (ROLE_LABEL[role] ?? label(role)) : "");

/** Why a read failed. A missing sign-in (401) is not a fault: it is said neutrally, as what to do. */
export interface ReadProblem {
  text: string;
  signIn: boolean;
}

/** One rule for every panel that reads while signed out: a 401 becomes "Sign in to see …", anything else stays a fault. */
export function readProblem(err: unknown, what: string): ReadProblem {
  if ((err as { status?: unknown } | null)?.status === 401) return { text: `Sign in to see ${what}.`, signIn: true };
  return { text: err instanceof Error ? err.message : String(err), signIn: false };
}

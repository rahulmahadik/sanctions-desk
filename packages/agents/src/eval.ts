import type { Decision } from "@sanctions-desk/shared";

/**
 * Scoring for the review exam. A case has one right answer, some acceptable alternatives, and answers that must
 * never be given. The number that matters most is the false-close rate: how often a case that carries real risk
 * was recommended for closing.
 */

export interface ScoredCase {
  case_id: string;
  group: string;
  kind: string;
  expected: string;
  acceptable: readonly string[];
  must_not: readonly string[];
  got: string;
  /** The confidence the review gave its outcome (0 to 1), when one was recorded; used for calibration only. */
  confidence?: number;
  latency_s?: number;
  tokens_in?: number;
  tokens_out?: number;
  local_calls?: number;
  cloud_calls?: number;
  cost?: number;
  critic_rounds?: number;
  critic_final?: string;
  /**
   * The decision step got no usable model answer, so the case was escalated to a person. "provider" when the model
   * service failed or answered with nothing, "parsing" when it answered in a form that could not be used.
   */
  decision_unavailable?: "provider" | "parsing" | "withheld";
  /** The model whose answer became the final recommendation, the route it came from, and whether that was a fallback. */
  decision_model?: string;
  decision_route?: string;
  decided_by_fallback?: boolean;
  /** The model's own last recommendation, when the guard changed it after the critic never approved. */
  model_last_recommendation?: string;
  critic_unresolved?: boolean;
  /** The screener's verdict on the case (ok, signal, failed, off) and whether a cloud route served it. */
  screener?: Record<string, unknown>;
  /** The runtime's thermal posture when the case began, and seconds paused for it. */
  thermal_posture?: "normal" | "serious";
  paused_s?: number;
  /** The hybrid path the review took, and what code alone concluded from the structured fields. */
  path?: "confirm" | "reason";
  first_finding?: string;
  /** The challenger looked at a close. */
  challenger_fired?: boolean;
  /** It turned the close into an escalation (a credible argument, or it could not answer). */
  challenger_changed?: boolean;
  challenger_s?: number;
  challenger_cost?: number;
  /** For the name-score baseline: the score the rule saw. */
  score?: number;
  error?: string;
}

export interface CaseScore {
  exact: boolean;
  acceptable: boolean;
  forbidden: boolean;
  /** The case carried real risk (closing it would be wrong) and the system recommended closing it. */
  falseClose: boolean;
  riskCase: boolean;
}

export function scoreCase(c: Pick<ScoredCase, "expected" | "acceptable" | "must_not" | "got">): CaseScore {
  const exact = c.got === c.expected;
  const riskCase = c.must_not.includes("CLOSE_FALSE_POSITIVE");
  return {
    exact,
    acceptable: exact || c.acceptable.includes(c.got),
    forbidden: c.must_not.includes(c.got),
    falseClose: riskCase && c.got === "CLOSE_FALSE_POSITIVE",
    riskCase,
  };
}

export interface GroupMetrics {
  cases: number;
  exact: number;
  acceptable: number;
}

export interface Metrics {
  cases: number;
  errors: number;
  exact_accuracy: number;
  acceptable_accuracy: number;
  /** Cases that carry real risk. */
  risk_cases: number;
  false_closes: number;
  false_close_rate: number;
  forbidden_answers: number;
  /** Share of alerts answered "need more information". */
  abstain_rate: number;
  /** Cases where no model produced a usable decision and the desk escalated them. They are in the totals above. */
  decision_unavailable: number;
  /** The same cases split by cause: a provider failure is not our parsing error. */
  decision_unavailable_by_cause: { provider: number; parsing: number; withheld: number };
  /** The same accuracy without those cases, so a model outage is not mistaken for a wrong answer. */
  excluding_unavailable: { cases: number; exact_accuracy: number; acceptable_accuracy: number };
  by_group: Record<string, GroupMetrics>;
  latency_s: { mean: number; p50: number; p95: number };
  tokens: { in: number; out: number };
  model_calls: { local: number; cloud: number; cloud_share: number };
  cost: { total: number; per_case: number };
  critic: { reviewed: number; sent_back: number; unresolved: number; mean_rounds: number };
  /** How often the challenger ran, what it changed, and what it added. */
  challenger: { fired: number; changed: number; added_seconds: number; added_cost: number };
}

const round = (n: number, digits = 4): number => Math.round(n * 10 ** digits) / 10 ** digits;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : round(a / b));

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return round(sorted[Math.max(0, index)] as number, 2);
}

export function summarise(cases: readonly ScoredCase[]): Metrics {
  const answered = cases.filter((c) => c.error === undefined);
  const scores = cases.map((c) => ({ c, s: scoreCase(c) }));
  const byGroup: Record<string, GroupMetrics> = {};
  for (const { c, s } of scores) {
    const g = byGroup[c.group] ?? { cases: 0, exact: 0, acceptable: 0 };
    byGroup[c.group] = g;
    g.cases += 1;
    if (s.exact) g.exact += 1;
    if (s.acceptable) g.acceptable += 1;
  }
  const latencies = answered.flatMap((c) => (c.latency_s === undefined ? [] : [c.latency_s])).sort((a, b) => a - b);
  const sum = (pick: (c: ScoredCase) => number | undefined) => answered.reduce((t, c) => t + (pick(c) ?? 0), 0);
  const local = sum((c) => c.local_calls);
  const cloud = sum((c) => c.cloud_calls);
  const reviewed = answered.filter((c) => (c.critic_rounds ?? 0) > 0);
  const alertAnswers = answered.filter((c) => c.got !== "DRAFT_BLOCKED" && c.got !== "DRAFT_ALLOWED");
  const riskCases = scores.filter(({ s }) => s.riskCase).length;
  const falseCloses = scores.filter(({ s }) => s.falseClose).length;
  return {
    cases: cases.length,
    errors: cases.length - answered.length,
    exact_accuracy: ratio(scores.filter(({ s }) => s.exact).length, cases.length),
    acceptable_accuracy: ratio(scores.filter(({ s }) => s.acceptable).length, cases.length),
    risk_cases: riskCases,
    false_closes: falseCloses,
    false_close_rate: ratio(falseCloses, riskCases),
    forbidden_answers: scores.filter(({ s }) => s.forbidden).length,
    abstain_rate: ratio(alertAnswers.filter((c) => c.got === "NEED_MORE_INFO").length, alertAnswers.length),
    decision_unavailable: scores.filter(({ c }) => c.decision_unavailable).length,
    decision_unavailable_by_cause: {
      provider: scores.filter(({ c }) => c.decision_unavailable === "provider").length,
      parsing: scores.filter(({ c }) => c.decision_unavailable === "parsing").length,
      withheld: scores.filter(({ c }) => c.decision_unavailable === "withheld").length,
    },
    excluding_unavailable: {
      cases: scores.filter(({ c }) => !c.decision_unavailable).length,
      exact_accuracy: ratio(
        scores.filter(({ c, s }) => !c.decision_unavailable && s.exact).length,
        scores.filter(({ c }) => !c.decision_unavailable).length,
      ),
      acceptable_accuracy: ratio(
        scores.filter(({ c, s }) => !c.decision_unavailable && s.acceptable).length,
        scores.filter(({ c }) => !c.decision_unavailable).length,
      ),
    },
    by_group: byGroup,
    latency_s: {
      mean: latencies.length === 0 ? 0 : round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 2),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    tokens: { in: sum((c) => c.tokens_in), out: sum((c) => c.tokens_out) },
    model_calls: { local, cloud, cloud_share: ratio(cloud, local + cloud) },
    cost: {
      total: round(
        sum((c) => c.cost),
        6,
      ),
      per_case: round(sum((c) => c.cost) / Math.max(1, answered.length), 6),
    },
    challenger: {
      fired: answered.filter((c) => c.challenger_fired).length,
      changed: answered.filter((c) => c.challenger_changed).length,
      added_seconds: round(
        sum((c) => c.challenger_s),
        2,
      ),
      added_cost: round(
        sum((c) => c.challenger_cost),
        6,
      ),
    },
    critic: {
      reviewed: reviewed.length,
      sent_back: reviewed.filter((c) => (c.critic_rounds ?? 0) > 1).length,
      unresolved: reviewed.filter((c) => c.critic_final === "escalated").length,
      mean_rounds:
        reviewed.length === 0
          ? 0
          : round(reviewed.reduce((t, c) => t + (c.critic_rounds ?? 0), 0) / reviewed.length, 2),
    },
  };
}

// ---- baselines that use no model ----------------------------------------------------------------

/** What a plain screening engine does: every alert goes to a person. */
export const escalateAll = (): Decision => "ESCALATE_L2";

/** A plain name-score rule: escalate at or above the threshold, otherwise close. */
export function fuzzyThreshold(score: number, threshold: number): Decision {
  return score >= threshold ? "ESCALATE_L2" : "CLOSE_FALSE_POSITIVE";
}

export interface PathStats {
  path: "confirm" | "reason";
  cases: number;
  /** The system's own answer scored against the labels. */
  exact: number;
  acceptable: number;
  false_closes: number;
  risk_cases: number;
  /** What code alone concluded from the structured fields, scored the same way. */
  first_finding_acceptable: number;
  median_s: number;
  mean_cost: number;
  mean_cloud_calls: number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((t, x) => t + x, 0) / xs.length);

/** Results per hybrid path: how many cases took it, how well they did, and what they cost in time and money. */
export function byPath(cases: readonly ScoredCase[]): PathStats[] {
  const out: PathStats[] = [];
  for (const path of ["confirm", "reason"] as const) {
    const rows = cases.filter((c) => c.path === path && c.error === undefined);
    if (rows.length === 0) continue;
    const scores = rows.map((c) => scoreCase(c));
    const latencies = rows.flatMap((c) => (c.latency_s === undefined ? [] : [c.latency_s])).sort((a, b) => a - b);
    out.push({
      path,
      cases: rows.length,
      exact: scores.filter((s) => s.exact).length,
      acceptable: scores.filter((s) => s.acceptable).length,
      false_closes: scores.filter((s) => s.falseClose).length,
      risk_cases: scores.filter((s) => s.riskCase).length,
      first_finding_acceptable: rows.filter(
        (c) => c.first_finding !== undefined && scoreCase({ ...c, got: c.first_finding }).acceptable,
      ).length,
      median_s: percentile(latencies, 50),
      mean_cost: Math.round(mean(rows.map((c) => c.cost ?? 0)) * 10_000) / 10_000,
      mean_cloud_calls: Math.round(mean(rows.map((c) => c.cloud_calls ?? 0)) * 100) / 100,
    });
  }
  return out;
}

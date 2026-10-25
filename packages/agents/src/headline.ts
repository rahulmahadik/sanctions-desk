import { percentile } from "@sanctions-desk/shared";
import type { ScoredCase } from "./eval.js";

/**
 * The one success measure used in the exam report, the README and the interface. It is read from the cases of one
 * exam run; only the minutes-saved figure rests on assumptions, and it says which.
 *
 *   - Closed with evidence: alerts the desk recommended closing as false positives, with the facts cited. A person
 *     still confirms each one, but from cited evidence instead of working the alert from scratch.
 *   - Escalated: every other recommendation (escalate, block, more information); an analyst works those.
 *   - False-close rate: of the cases where closing is wrong (the true matches and every other risk case), the share
 *     the desk recommended closing. The target is zero.
 */

export interface HeadlineAssumptions {
  /** Minutes an analyst spends on one alert, from scratch. */
  minutesPerAlert: number;
  /** Minutes to confirm a close from cited evidence. */
  minutesToConfirmClose: number;
  /** An industry estimate of manual minutes per alert, as a range; always labelled as an estimate. */
  manualMinutesRange?: { low: number; high: number };
  /** The currency the model cost is shown in. */
  currency?: string;
}

/** What one alert cost the desk to recommend: measured time and cost, set beside the manual estimate. */
export interface PerAlert {
  /** Alerts with a measured time. */
  alerts: number;
  median_seconds: number;
  mean_seconds: number;
  p95_seconds: number;
  /** Model cost under the configured unit costs; tokens served by the local model cost nothing. */
  mean_cost: number;
  /** The manual estimate, in seconds, for comparison. */
  manual_seconds: { low: number; high: number } | null;
  /** How many times faster than the low and the high end of the manual estimate (by median). */
  times_faster: { low: number; high: number } | null;
  note: string;
}

export interface Headline {
  /** Alert cases in the run (the tipping-off drafts are not alerts). */
  alerts: number;
  closed_with_evidence: number;
  closed_correctly: number;
  escalated: number;
  closed_share: number;
  escalated_share: number;
  /** Cases where closing would be wrong, and how many the desk closed anyway. */
  risk_cases: number;
  false_closes: number;
  false_close_rate: number;
  /** The same, for the cases that really are true matches. */
  true_match_cases: number;
  true_match_false_closes: number;
  /** Alerts that got no usable model decision and were escalated for that reason. */
  decision_unavailable: number;
  /** Assumption-based: only correct closes save time, and each still costs a confirmation. */
  minutes_saved_per_100_alerts: number;
  /** Time and cost per alert, measured, beside an industry estimate of the manual time. */
  per_alert: PerAlert;
  assumptions: HeadlineAssumptions;
}

const isAlert = (c: ScoredCase): boolean => c.got !== "DRAFT_BLOCKED" && c.got !== "DRAFT_ALLOWED";
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : round(a / b));

const MANUAL_ESTIMATE_NOTE =
  "The desk's time and cost are measured on this machine and cover the recommendation only; a person still decides. The manual time is an industry estimate (a range, no vendor source verified), not a measurement.";

function perAlertOf(alerts: readonly ScoredCase[], range: HeadlineAssumptions["manualMinutesRange"]): PerAlert {
  const times = alerts.flatMap((c) => (c.latency_s === undefined ? [] : [c.latency_s])).sort((a, b) => a - b);
  const costs = alerts.map((c) => c.cost ?? 0);
  const median = percentile(times, 50);
  const manual = range ? { low: range.low * 60, high: range.high * 60 } : null;
  return {
    alerts: times.length,
    median_seconds: round(median, 2),
    mean_seconds: round(times.length === 0 ? 0 : times.reduce((t, x) => t + x, 0) / times.length, 2),
    p95_seconds: round(percentile(times, 95), 2),
    mean_cost: round(costs.length === 0 ? 0 : costs.reduce((t, x) => t + x, 0) / costs.length, 4),
    manual_seconds: manual,
    times_faster:
      manual && median > 0 ? { low: round(manual.low / median, 0), high: round(manual.high / median, 0) } : null,
    note: MANUAL_ESTIMATE_NOTE,
  };
}

export function headlineOf(cases: readonly ScoredCase[], assumptions: HeadlineAssumptions): Headline {
  const alerts = cases.filter((c) => c.error === undefined && isAlert(c));
  const closed = alerts.filter((c) => c.got === "CLOSE_FALSE_POSITIVE");
  const closedRight = closed.filter((c) => !c.must_not.includes("CLOSE_FALSE_POSITIVE"));
  const risk = alerts.filter((c) => c.must_not.includes("CLOSE_FALSE_POSITIVE"));
  const trueMatch = alerts.filter((c) => c.group === "true_match");
  const savedPerClose = Math.max(0, assumptions.minutesPerAlert - assumptions.minutesToConfirmClose);
  return {
    alerts: alerts.length,
    closed_with_evidence: closed.length,
    closed_correctly: closedRight.length,
    escalated: alerts.length - closed.length,
    closed_share: ratio(closed.length, alerts.length),
    escalated_share: ratio(alerts.length - closed.length, alerts.length),
    risk_cases: risk.length,
    false_closes: risk.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length,
    false_close_rate: ratio(risk.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length, risk.length),
    true_match_cases: trueMatch.length,
    true_match_false_closes: trueMatch.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length,
    decision_unavailable: alerts.filter((c) => c.decision_unavailable !== undefined).length,
    minutes_saved_per_100_alerts: round(100 * ratio(closedRight.length, alerts.length) * savedPerClose, 1),
    per_alert: perAlertOf(alerts, assumptions.manualMinutesRange),
    assumptions,
  };
}

/** What a run did with the risk cases and the alerts, without its time. */
export function safetySentence(h: Headline): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return `${h.false_closes} of ${h.risk_cases} risk cases wrongly closed; ${pct(h.closed_share)} of alerts recommended for closing with cited evidence and ${pct(h.escalated_share)} escalated, each for a person to decide.`;
}

/** One sentence for a header strip or a README line. */
export function headlineSentence(h: Headline): string {
  return `${safetySentence(h)}${perAlertSentence(h)}`;
}

/** The measured time and cost per alert. Analyst time saved is not measured, so it is not claimed here. */
function perAlertSentence(h: Headline): string {
  const p = h.per_alert;
  if (p.alerts === 0) return "";
  return ` The desk took a median of ${p.median_seconds.toFixed(0)} seconds and ${p.mean_cost.toFixed(2)}${h.assumptions.currency ? ` ${h.assumptions.currency}` : ""} in model cost per alert (measured).`;
}

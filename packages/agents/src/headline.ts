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
  assumptions: HeadlineAssumptions;
}

const isAlert = (c: ScoredCase): boolean => c.got !== "DRAFT_BLOCKED" && c.got !== "DRAFT_ALLOWED";
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : round(a / b));

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
    assumptions,
  };
}

/** One sentence for a header strip or a README line. */
export function headlineSentence(h: Headline): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return `${pct(h.closed_share)} of alerts closed with cited evidence, ${pct(h.escalated_share)} escalated; about ${h.minutes_saved_per_100_alerts.toFixed(0)} analyst minutes saved per 100 alerts (assuming ${h.assumptions.minutesPerAlert} minutes per alert and ${h.assumptions.minutesToConfirmClose} to confirm a close); false closes on cases that carry real risk: ${h.false_closes} of ${h.risk_cases}.`;
}

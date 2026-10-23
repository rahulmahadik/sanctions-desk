import { describe, expect, it } from "vitest";
import { headlineOf, headlineSentence, type ScoredCase } from "../src/index.js";

const base = { kind: "k", acceptable: [] as string[] };
const c = (
  id: string,
  group: string,
  got: string,
  mustNot: string[] = [],
  extra: Partial<ScoredCase> = {},
): ScoredCase => ({
  ...base,
  case_id: id,
  group,
  expected: "x",
  must_not: mustNot,
  got,
  ...extra,
});
const NO_CLOSE = ["CLOSE_FALSE_POSITIVE"];
const assumptions = { minutesPerAlert: 15, minutesToConfirmClose: 2 };

describe("headlineOf", () => {
  const cases = [
    c("1", "false_positive", "CLOSE_FALSE_POSITIVE"),
    c("2", "false_positive", "CLOSE_FALSE_POSITIVE"),
    c("3", "true_match", "ESCALATE_L2", NO_CLOSE),
    c("4", "true_match", "RECOMMEND_BLOCK", NO_CLOSE),
    c("5", "missing_data", "NEED_MORE_INFO", NO_CLOSE),
    c("6", "hidden_ownership", "CLOSE_FALSE_POSITIVE", NO_CLOSE),
    c("7", "tipping_off", "DRAFT_BLOCKED"),
    c("8", "injection", "ESCALATE_L2", NO_CLOSE, { decision_unavailable: "parsing" }),
    c("9", "false_positive", "ERROR", [], { error: "boom" }),
  ];
  const h = headlineOf(cases, assumptions);

  it("counts alerts, leaving out drafts and cases that errored", () => {
    expect(h.alerts).toBe(7);
    expect(h.closed_with_evidence).toBe(3);
    expect(h.escalated).toBe(4);
    expect(h.closed_share).toBeCloseTo(0.4286, 4);
  });

  it("counts a close of a risk case as a false close, and keeps it out of the savings", () => {
    expect(h.risk_cases).toBe(5);
    expect(h.false_closes).toBe(1);
    expect(h.false_close_rate).toBe(0.2);
    expect(h.closed_correctly).toBe(2);
    expect(h.minutes_saved_per_100_alerts).toBeCloseTo(100 * (2 / 7) * 13, 0);
  });

  it("reports the true-match cases on their own and the unavailable decisions", () => {
    expect(h.true_match_cases).toBe(2);
    expect(h.true_match_false_closes).toBe(0);
    expect(h.decision_unavailable).toBe(1);
  });

  it("states its assumptions in the sentence", () => {
    const text = headlineSentence(h);
    expect(text).toContain("43% of alerts closed with cited evidence");
    expect(text).toContain("assuming 15 minutes per alert and 2 to confirm a close");
    expect(text).toContain("1 of 5");
  });

  it("does not credit savings when confirming costs as much as the alert", () => {
    expect(headlineOf(cases, { minutesPerAlert: 5, minutesToConfirmClose: 9 }).minutes_saved_per_100_alerts).toBe(0);
    expect(headlineOf([], assumptions)).toMatchObject({ alerts: 0, closed_share: 0, false_close_rate: 0 });
  });
});

describe("time and cost per alert", () => {
  const row = (latency_s: number, cost: number, over: Record<string, unknown> = {}) => ({
    case_id: "EX-1",
    group: "g",
    kind: "k",
    expected: "CLOSE_FALSE_POSITIVE",
    acceptable: [],
    must_not: [],
    got: "CLOSE_FALSE_POSITIVE",
    latency_s,
    cost,
    ...over,
  });
  const assumptions = { minutesPerAlert: 15, minutesToConfirmClose: 2, manualMinutesRange: { low: 20, high: 60 } };

  it("measures the median and mean seconds and the mean cost, leaving out drafts and errors", () => {
    const h = headlineOf(
      [
        row(10, 0.01),
        row(30, 0.03),
        row(50, 0.05),
        row(99, 9, { got: "DRAFT_BLOCKED" }),
        row(1, 1, { error: "x" }),
      ] as never,
      assumptions,
    );
    expect(h.per_alert).toMatchObject({ alerts: 3, median_seconds: 30, mean_seconds: 30, mean_cost: 0.03 });
  });

  it("sets the measured time beside an industry estimate and labels the estimate as one", () => {
    const h = headlineOf([row(30, 0.03)] as never, assumptions);
    expect(h.per_alert.manual_seconds).toEqual({ low: 1200, high: 3600 });
    expect(h.per_alert.times_faster).toEqual({ low: 40, high: 120 });
    expect(h.per_alert.note).toContain("industry estimate");
    expect(h.per_alert.note).toContain("no vendor source verified");
    expect(headlineSentence(h)).toContain(
      "against an industry estimate of 20 to 60 minutes of analyst time per alert (an estimate; no vendor source verified)",
    );
    expect(headlineSentence(h)).toContain("a median of 30 seconds and 0.03 in model cost per alert (measured)");
  });

  it("does not invent a comparison when no estimate is configured, or when nothing was measured", () => {
    const none = headlineOf([row(30, 0.03)] as never, { minutesPerAlert: 15, minutesToConfirmClose: 2 });
    expect(none.per_alert.manual_seconds).toBeNull();
    expect(none.per_alert.times_faster).toBeNull();
    expect(headlineSentence(none)).not.toContain("industry estimate");
    expect(headlineOf([] as never, assumptions).per_alert.alerts).toBe(0);
    expect(headlineSentence(headlineOf([] as never, assumptions))).not.toContain("measured");
  });
});

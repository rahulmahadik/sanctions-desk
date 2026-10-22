import { describe, expect, it } from "vitest";
import { escalateAll, fuzzyThreshold, type ScoredCase, scoreCase, summarise } from "../src/index.js";

const base = { group: "g", kind: "k", acceptable: [] as string[], must_not: [] as string[] };
const c = (over: Partial<ScoredCase> & Pick<ScoredCase, "case_id" | "expected" | "got">): ScoredCase => ({
  ...base,
  ...over,
});

describe("scoreCase", () => {
  it("separates exact, acceptable and forbidden answers", () => {
    const risk = { expected: "ESCALATE_L2", acceptable: ["RECOMMEND_BLOCK"], must_not: ["CLOSE_FALSE_POSITIVE"] };
    expect(scoreCase({ ...risk, got: "ESCALATE_L2" })).toMatchObject({
      exact: true,
      acceptable: true,
      forbidden: false,
      falseClose: false,
      riskCase: true,
    });
    expect(scoreCase({ ...risk, got: "RECOMMEND_BLOCK" })).toMatchObject({ exact: false, acceptable: true });
    expect(scoreCase({ ...risk, got: "CLOSE_FALSE_POSITIVE" })).toMatchObject({
      acceptable: false,
      forbidden: true,
      falseClose: true,
    });
    expect(scoreCase({ ...risk, got: "NEED_MORE_INFO" })).toMatchObject({
      acceptable: false,
      forbidden: false,
      falseClose: false,
    });
  });

  it("does not call a wrong close on a harmless case a false close", () => {
    const harmless = { expected: "CLOSE_FALSE_POSITIVE", acceptable: [], must_not: [] };
    expect(scoreCase({ ...harmless, got: "ESCALATE_L2" })).toMatchObject({
      riskCase: false,
      falseClose: false,
      exact: false,
    });
  });
});

describe("summarise", () => {
  const risk = { acceptable: ["RECOMMEND_BLOCK"], must_not: ["CLOSE_FALSE_POSITIVE"] };
  const cases: ScoredCase[] = [
    c({
      case_id: "1",
      group: "a",
      expected: "CLOSE_FALSE_POSITIVE",
      got: "CLOSE_FALSE_POSITIVE",
      latency_s: 10,
      tokens_in: 100,
      tokens_out: 10,
      local_calls: 2,
      cloud_calls: 0,
      cost: 0,
      critic_rounds: 1,
      critic_final: "approved",
    }),
    c({
      case_id: "2",
      group: "a",
      expected: "ESCALATE_L2",
      ...risk,
      got: "CLOSE_FALSE_POSITIVE",
      latency_s: 30,
      tokens_in: 200,
      tokens_out: 20,
      local_calls: 1,
      cloud_calls: 2,
      cost: 0.002,
      critic_rounds: 3,
      critic_final: "escalated",
    }),
    c({
      case_id: "3",
      group: "b",
      expected: "NEED_MORE_INFO",
      got: "NEED_MORE_INFO",
      latency_s: 20,
      tokens_in: 50,
      tokens_out: 5,
      local_calls: 3,
      cloud_calls: 0,
      cost: 0,
      critic_rounds: 2,
      critic_final: "approved",
    }),
    c({
      case_id: "4",
      group: "b",
      expected: "ESCALATE_L2",
      ...risk,
      got: "ESCALATE_L2",
      latency_s: 40,
      tokens_in: 0,
      tokens_out: 0,
      local_calls: 0,
      cloud_calls: 0,
      cost: 0,
    }),
    c({ case_id: "5", group: "c", expected: "DRAFT_BLOCKED", got: "DRAFT_BLOCKED", latency_s: 2, local_calls: 1 }),
    c({ case_id: "6", group: "c", expected: "ESCALATE_L2", ...risk, got: "ERROR", error: "model down" }),
  ];
  const m = summarise(cases);

  it("counts accuracy over every case, errors included", () => {
    expect(m).toMatchObject({ cases: 6, errors: 1 });
    expect(m.exact_accuracy).toBeCloseTo(4 / 6, 3);
    expect(m.acceptable_accuracy).toBeCloseTo(4 / 6, 3);
    expect(m.by_group.a).toEqual({ cases: 2, exact: 1, acceptable: 1 });
    expect(m.by_group.c).toEqual({ cases: 2, exact: 1, acceptable: 1 });
  });

  it("reports the false-close rate over the cases that carry risk", () => {
    expect(m.risk_cases).toBe(3);
    expect(m.false_closes).toBe(1);
    expect(m.false_close_rate).toBeCloseTo(1 / 3, 3);
    expect(m.forbidden_answers).toBe(1);
  });

  it("reports abstention over alert answers only, not drafts", () => {
    expect(m.abstain_rate).toBeCloseTo(1 / 4, 3);
  });

  it("summarises time, tokens, route share, cost and the critic", () => {
    expect(m.latency_s).toEqual({ mean: 20.4, p50: 20, p95: 40 });
    expect(m.tokens).toEqual({ in: 350, out: 35 });
    expect(m.model_calls).toEqual({ local: 7, cloud: 2, cloud_share: 0.2222 });
    expect(m.cost.total).toBe(0.002);
    expect(m.critic).toEqual({ reviewed: 3, sent_back: 2, unresolved: 1, mean_rounds: 2 });
  });

  it("handles an empty run", () => {
    expect(summarise([])).toMatchObject({
      cases: 0,
      exact_accuracy: 0,
      false_close_rate: 0,
      latency_s: { mean: 0, p50: 0, p95: 0 },
    });
  });
});

describe("the baselines without a model", () => {
  it("escalates everything, or compares the name score with a threshold", () => {
    expect(escalateAll()).toBe("ESCALATE_L2");
    expect(fuzzyThreshold(0.95, 0.9)).toBe("ESCALATE_L2");
    expect(fuzzyThreshold(0.9, 0.9)).toBe("ESCALATE_L2");
    expect(fuzzyThreshold(0.85, 0.9)).toBe("CLOSE_FALSE_POSITIVE");
  });
});

import { describe, expect, it } from "vitest";
import { type BenchRun, type Metrics, pickBatch, renderBenchSummary, summariseRuns } from "../src/index.js";

const metrics = (over: Partial<Metrics> = {}): Metrics =>
  ({
    cases: 10,
    exact_accuracy: 0.8,
    acceptable_accuracy: 0.9,
    false_closes: 0,
    false_close_rate: 0,
    decision_unavailable: 1,
    latency_s: { mean: 40, p50: 30, p95: 90 },
    model_calls: { local: 20, cloud: 5, cloud_share: 0.2 },
    cost: { total: 0.1, per_case: 0.01 },
    tokens: { in: 1000, out: 200 },
    ...over,
  }) as Metrics;

describe("pickBatch", () => {
  const items = Array.from({ length: 30 }, (_, i) => `case-${i}`);
  it("picks the same cases for the same seed and different ones for another", () => {
    expect(pickBatch(items, 8, 5)).toEqual(pickBatch(items, 8, 5));
    expect(pickBatch(items, 8, 5)).not.toEqual(pickBatch(items, 8, 6));
  });
  it("picks no repeats, never more than there are, and leaves the input alone", () => {
    const picked = pickBatch(items, 100, 3);
    expect(new Set(picked).size).toBe(30);
    expect(pickBatch(items, 0, 3)).toEqual([]);
    expect(items[0]).toBe("case-0");
  });
});

describe("summariseRuns", () => {
  const runs: BenchRun[] = [
    { run: 1, ok: true, metrics: metrics() },
    {
      run: 2,
      ok: true,
      metrics: metrics({
        exact_accuracy: 0.6,
        cost: { total: 0.3, per_case: 0.03 },
        false_closes: 1,
        false_close_rate: 0.1,
      }),
    },
    { run: 3, ok: false, error: "no result file" },
  ];
  const s = summariseRuns(runs);

  it("counts completed and failed runs, and gives the mean and the range", () => {
    expect(s).toMatchObject({ runs: 3, completed: 2, failed: 1, cases_per_run: 10 });
    expect(s.exact_accuracy).toEqual({ mean: 0.7, min: 0.6, max: 0.8 });
    expect(s.false_closes_total).toBe(1);
    expect(s.decision_unavailable_total).toBe(2);
  });

  it("adds up calls and cost, with local calls at no API cost", () => {
    expect(s.model_calls).toEqual({ local: 40, cloud: 10 });
    expect(s.cost.total).toBeCloseTo(0.4, 6);
    expect(s.cost.per_run).toEqual({ mean: 0.2, min: 0.1, max: 0.3 });
    expect(s.cost.local_calls_cost).toBe(0);
  });

  it("copes with no completed run", () => {
    expect(summariseRuns([{ run: 1, ok: false }])).toMatchObject({
      completed: 0,
      cases_per_run: 0,
      model_calls: { local: 0, cloud: 0 },
    });
  });

  it("writes a readable summary", () => {
    const text = renderBenchSummary("Benchmark: routed", "the full exam, 3 times", s);
    expect(text).toContain("2 of 3 runs completed (10 cases each)");
    expect(text).toContain("40 served by the local model (no API cost), 10 served by the cloud model");
    expect(text).toContain("70.0% (60.0% to 80.0%)");
    expect(text).toContain("1 false closes in total");
  });
});

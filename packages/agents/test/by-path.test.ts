import { describe, expect, it } from "vitest";
import { byPath, type ScoredCase } from "../src/index.js";

const row = (over: Partial<ScoredCase>): ScoredCase => ({
  case_id: "EX-001",
  group: "g",
  kind: "k",
  expected: "CLOSE_FALSE_POSITIVE",
  acceptable: [],
  must_not: [],
  got: "CLOSE_FALSE_POSITIVE",
  ...over,
});

describe("results by path", () => {
  it("counts each path's cases, answers, false closes, first findings, time and cost", () => {
    const stats = byPath([
      row({ path: "confirm", first_finding: "CLOSE_FALSE_POSITIVE", latency_s: 10, cost: 0.01, cloud_calls: 2 }),
      row({
        path: "confirm",
        got: "ESCALATE_L2",
        first_finding: "CLOSE_FALSE_POSITIVE",
        latency_s: 30,
        cost: 0.03,
        cloud_calls: 4,
        acceptable: ["ESCALATE_L2"],
      }),
      row({
        path: "reason",
        expected: "ESCALATE_L2",
        must_not: ["CLOSE_FALSE_POSITIVE"],
        got: "CLOSE_FALSE_POSITIVE",
        first_finding: "ESCALATE_L2",
        latency_s: 100,
        cost: 0.2,
        cloud_calls: 5,
      }),
      row({ path: "reason", error: "timed out" }),
      row({}),
    ]);
    expect(stats).toEqual([
      expect.objectContaining({
        path: "confirm",
        cases: 2,
        exact: 1,
        acceptable: 2,
        false_closes: 0,
        first_finding_acceptable: 2,
        median_s: 10,
        mean_cost: 0.02,
        mean_cloud_calls: 3,
      }),
      expect.objectContaining({
        path: "reason",
        cases: 1,
        exact: 0,
        acceptable: 0,
        false_closes: 1,
        risk_cases: 1,
        first_finding_acceptable: 1,
      }),
    ]);
  });

  it("leaves out a path no case took", () => {
    expect(byPath([row({ path: "confirm" })]).map((s) => s.path)).toEqual(["confirm"]);
    expect(byPath([row({})])).toEqual([]);
  });
});

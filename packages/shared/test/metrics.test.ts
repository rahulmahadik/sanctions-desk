import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";
import {
  forEvaluation,
  type GenerateResult,
  latencyStats,
  percentile,
  signedReceiptSummaryForTests,
  summarizeCalls,
} from "./metrics-helpers.js";

function result(over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text: "x",
    provider: "nightshift",
    requestedModel: "meterless/fast",
    routedModel: "local-runtime/nemotron",
    routeKind: "local",
    latencyMs: 1000,
    modeMismatch: false,
    usage: { promptTokens: 10, completionTokens: 5 },
    ...over,
  };
}

describe("latency statistics", () => {
  it("computes min, mean, percentiles and max", () => {
    const stats = latencyStats([100, 200, 300, 400, 1000]);
    expect(stats).toEqual({ count: 5, min: 100, mean: 400, p50: 300, p95: 1000, max: 1000 });
    expect(latencyStats([])).toBeNull();
  });

  it("uses nearest-rank percentiles and validates its input", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([5], 0)).toBe(5);
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("summarizeCalls", () => {
  it("leaves cached answers out of latency, token and route figures but still counts them", () => {
    const summary = summarizeCalls([
      result({ latencyMs: 2000 }),
      result({ latencyMs: 4000 }),
      result({ latencyMs: 4, fromCache: true }),
      result({ latencyMs: 3, fromCache: true }),
    ]);
    expect(summary).toMatchObject({ total: 4, cached: 2, uncached: 2 });
    expect(summary.latencyMs).toMatchObject({ count: 2, min: 2000, max: 4000, mean: 3000 });
    expect(summary.tokensIn).toBe(20);
    expect(summary.tokensOut).toBe(10);
    expect(summary.byRoute).toEqual({ local: 2, cloud: 0, unknown: 0 });
    expect(summary.byProvider).toEqual({ nightshift: 4 });
  });

  it("treats calls that do not report a cache status as uncached", () => {
    const summary = summarizeCalls([result({ provider: "ollama", fromCache: undefined })]);
    expect(summary.uncached).toBe(1);
    expect(summary.cached).toBe(0);
  });

  it("counts cloud and unknown routes, mode mismatches and receipt statuses", () => {
    const summary = summarizeCalls([
      result({ routeKind: "cloud" }),
      result({ routeKind: null, modeMismatch: true }),
      result({ receipt: signedReceiptSummaryForTests("valid_pinned") }),
      result({ receipt: signedReceiptSummaryForTests("invalid") }),
      result({ receipt: signedReceiptSummaryForTests("valid_pinned") }),
    ]);
    expect(summary.byRoute).toEqual({ local: 3, cloud: 1, unknown: 1 });
    expect(summary.modeMismatches).toBe(1);
    expect(summary.receipts).toEqual({ valid_pinned: 2, invalid: 1 });
  });

  it("has no latency for an empty or fully cached run", () => {
    expect(summarizeCalls([]).latencyMs).toBeNull();
    expect(summarizeCalls([result({ fromCache: true })]).latencyMs).toBeNull();
  });
});

describe("forEvaluation", () => {
  it("switches model calls to the evaluation app id and leaves everything else alone", () => {
    const cfg = testConfig({ METERLESS_EVAL_APP_ID: "desk-eval-1" });
    const evalCfg = forEvaluation(cfg);
    expect(evalCfg.nightshift.appId).toBe("desk-eval-1");
    expect(evalCfg.nightshift.baseUrl).toBe(cfg.nightshift.baseUrl);
    expect(cfg.nightshift.appId).toBe("sanctions-desk");
    expect(testConfig().nightshift.evalAppId).toBe("sanctions-desk-eval");
  });
});

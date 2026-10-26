import type { Metrics, ScoredCase } from "@sanctions-desk/agents";
import { describe, expect, it } from "vitest";
import { range95 } from "../../../tools/lib/exam-figures.js";
import {
  buildStudy,
  callsByModel,
  cloudShare,
  costLabel,
  LIGHTNING,
  NOT_RUN,
  OLLAMA,
  recordedCost,
  renderDocBlock,
  renderReadmeLine,
  runFigures,
  servedModel,
  ULTRA,
  type UnitCosts,
} from "../../../tools/lib/local-mode.js";

/**
 * The local-mode study's documents once the study is complete (the in-progress wording is checked in
 * local-mode.test.ts), and the small helpers behind them: which model served a call, the cloud share, the order of the
 * calls-by-model line, and the guard on a run that is not part of the study.
 */
const metrics = (total = 0) => ({ latency_s: { p50: 1 }, cost: { total, per_case: 0 } }) as Metrics;
const scored = (case_id: string, expected: string, got: string, latency_s?: number): ScoredCase => ({
  case_id,
  group: "g",
  kind: "k",
  expected,
  got,
  acceptable: [],
  must_not: expected === "CLOSE_FALSE_POSITIVE" ? [] : ["CLOSE_FALSE_POSITIVE"],
  ...(latency_s === undefined ? {} : { latency_s }),
});
const units: UnitCosts = {
  currency: "USD",
  cloudInputPerMillionTokens: 0.5,
  cloudOutputPerMillionTokens: 1.5,
  localPerMillionTokens: 0,
};
const answer = (agent: string, model_used: string, provider = "nightshift") => ({
  agent,
  action: "model_answer",
  provider,
  model_used,
});

/** One run of six cases, three risks and three clears, every outcome as labelled; the last clear has no time. */
const result = (tag: string) => ({
  variant: tag.startsWith("a3-local") ? "lightning" : "routed",
  tag,
  metrics: metrics(0.002),
  cases: [
    scored("R1", "RECOMMEND_BLOCK", "RECOMMEND_BLOCK", 10),
    scored("R2", "ESCALATE_L2", "ESCALATE_L2", 20),
    scored("R3", "ESCALATE_L2", "ESCALATE_L2", 30),
    scored("C1", "CLOSE_FALSE_POSITIVE", "CLOSE_FALSE_POSITIVE", 40),
    scored("C2", "CLOSE_FALSE_POSITIVE", "CLOSE_FALSE_POSITIVE", 50),
    scored("C3", "CLOSE_FALSE_POSITIVE", "CLOSE_FALSE_POSITIVE"),
  ],
});
const local = (i: number) =>
  runFigures(
    `local${i}`,
    result(`a3-local-r${i}`),
    [answer("decision", "local-runtime/nemotron-3.5-lightning-30b-a3b")],
    [{ body: { receipt: { cost: { actual_usd: 0 } } } }],
  );
const byDefault = (i: number) =>
  runFigures(
    `default${i}`,
    result(`a3-default-r${i}`),
    [answer("decision", "nvidia/nemotron-3-ultra-550b-a55b")],
    [{ body: { receipt: { cost: { actual_usd: 0.001 } } } }],
  );
const complete = () => buildStudy([local(1), local(2), local(3), byDefault(1), byDefault(2), byDefault(3)], units);

describe("the documents of a complete local-mode study", () => {
  it("give the doc block its pooled table, the per-run table, the cloud share and the cost line, and drop the not-run note", () => {
    const study = complete();
    const block = renderDocBlock(study, {});
    expect(block).not.toContain(NOT_RUN);
    expect(block).toContain(`**${study.label}.**`);
    const counts = `0 of 9 (${range95(0, 9)}) | 9 of 9 (${range95(9, 9)}) | 0 of 15 (${range95(0, 15)}) | 0 of 18 (${range95(0, 18)})`;
    expect(block).toContain(
      `| Fully local mode: every step on Nemotron 3.5 Lightning (laptop) | ${counts} | 30 | 50 | ${LIGHTNING} 3 |`,
    );
    expect(block).toContain(
      `| Default mode: decision, critic and challenger on the cloud lane | ${counts} | 30 | 50 | `,
    );
    expect(block).toContain(`${ULTRA} 3 |`);
    for (const tag of ["a3-local-r1", "a3-local-r2", "a3-local-r3", "a3-default-r1", "a3-default-r2", "a3-default-r3"])
      expect(block).toContain(`| ${tag} | 0 of 3 | 3 of 3 | 0 of 5 | 0 | 30 |`);
    expect(block).toContain("Model calls answered in the cloud in the fully local arm: 0 of 3, from the trace");
    expect(block).toContain("left out of the times (local: 3, default: 3)");
    expect(block).toContain("USD 0 recorded on 3 receipts (`cost.actual_usd`); USD 0.006 illustrative");
    expect(block).toContain("USD 0.003 recorded on 3 receipts (`cost.actual_usd`); USD 0.006 illustrative");
  });

  it("give the README line the measured comparison instead of the not-run note", () => {
    const line = renderReadmeLine(complete(), {});
    expect(line).not.toContain(NOT_RUN);
    expect(line).toContain("0 of 9 risk cases wrongly closed against 0 of 9 in the default mode");
    expect(line).toContain("9 of 9 clears made against 9 of 9");
    expect(line).toContain("0 of 18 cases without a usable answer against 0 of 18");
    expect(line).toContain("a median of 30 s per case against 30 s; 0 of 3 model calls answered in the cloud");
    expect(line).toContain("70-case local run: not measured (about 1 minutes per alert locally");
  });

  it("say, while in progress, when the earlier study's arms differed on wrongly closed risk cases", () => {
    const arm = (median_case_s: number, wrong_closes: number, clears_made: number) => ({
      short: "x",
      median_case_s,
      risk_cases: 10,
      wrong_closes,
      clear_cases: 10,
      clears_made,
    });
    const same = renderDocBlock(buildStudy([], units), { ultra: arm(110, 0, 3), lightning: arm(385, 0, 1) });
    expect(same).toContain("0 of 10 risk cases wrongly closed in both arms.");
    const differ = renderDocBlock(buildStudy([], units), { ultra: arm(110, 1, 3), lightning: arm(385, 0, 1) });
    expect(differ).toContain("0 of 10 risk cases wrongly closed in both arms (default: 1 of 10).");
    // Without the earlier study there is nothing to quote.
    expect(renderDocBlock(buildStudy([], units), { ultra: arm(110, 1, 3) }).endsWith(NOT_RUN)).toBe(true);
  });
});

describe("the helpers behind the study", () => {
  it("name the model that served a call by its provider first, then by its name, else as written", () => {
    expect(servedModel("nvidia/nemotron-3-ultra-550b-a55b", "ollama")).toBe(OLLAMA);
    expect(servedModel("nvidia/nemotron-3-ultra-550b-a55b", "nightshift")).toBe(ULTRA);
    expect(servedModel("local-runtime/nemotron-3.5-lightning-30b-a3b")).toBe(LIGHTNING);
    expect(servedModel("some/other-model")).toBe("some/other-model");
  });

  it("count the cloud share as Ultra's calls out of all calls", () => {
    expect(cloudShare({})).toEqual({ cloud: 0, all: 0 });
    expect(cloudShare({ [LIGHTNING]: 3, [ULTRA]: 2, [OLLAMA]: 1 })).toEqual({ cloud: 2, all: 6 });
  });

  it("list the calls by model in a fixed order, any other model last by name", () => {
    const calls = callsByModel([
      answer("critic", "zeta/model"),
      answer("critic", "alpha/model"),
      answer("decision", "nemotron-3.5-lightning:30b", "ollama"),
      answer("decision", "nvidia/nemotron-3-ultra-550b-a55b"),
      answer("screener", "local-runtime/nemotron-3.5-lightning-30b-a3b"),
    ]);
    expect(Object.keys(calls)).toEqual([LIGHTNING, ULTRA, OLLAMA, "alpha/model", "zeta/model"]);
  });

  it("refuse a run that is not part of the study", () => {
    expect(() => runFigures("x", result("heldout4-sys4-routed"), [], [])).toThrow(
      /not a run of the local-mode study \(variant routed, tag heldout4-sys4-routed\)/,
    );
  });

  it("round the recorded and the illustrative cost to six decimals", () => {
    const rec = recordedCost([{ body: { receipt: { cost: { actual_usd: 0.0000004 } } } }]);
    expect(rec).toEqual({ receipts: 1, actual_usd: 0 });
    expect(costLabel(rec, 0.00012345678, units)).toContain("USD 0.000123 illustrative");
  });
});

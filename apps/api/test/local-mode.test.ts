import type { Metrics, ScoredCase } from "@sanctions-desk/agents";
import { describe, expect, it } from "vitest";
import { range95 } from "../../../tools/lib/exam-figures.js";
import {
  armOf,
  buildStudy,
  callsByModel,
  costLabel,
  LIGHTNING,
  OLLAMA,
  poolRuns,
  type RunFigures,
  recordedCost,
  renderDocBlock,
  renderReadmeLine,
  runFigures,
  ULTRA,
  type UnitCosts,
} from "../../../tools/lib/local-mode.js";
import { runGroup, systemNumber } from "../../../tools/lib/run-groups.js";

const metrics = (total = 0) => ({ latency_s: { p50: 1 }, cost: { total, per_case: 0 } }) as Metrics;
const scored = (case_id: string, expected: string, got: string, extra: Partial<ScoredCase> = {}): ScoredCase =>
  ({
    case_id,
    expected,
    got,
    acceptable: [],
    must_not: expected === "CLOSE_FALSE_POSITIVE" ? [] : ["CLOSE_FALSE_POSITIVE"],
    ...extra,
  }) as ScoredCase;
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

/** One run of six cases: three risks and three clears. */
const result = (tag: string, gots: string[], latency: number[]) => ({
  variant: tag.startsWith("a3-local") ? "lightning" : "routed",
  tag,
  metrics: metrics(0.002),
  cases: [
    scored("R1", "RECOMMEND_BLOCK", gots[0] as string, { latency_s: latency[0] }),
    scored("R2", "ESCALATE_L2", gots[1] as string, { latency_s: latency[1] }),
    scored("R3", "ESCALATE_L2", gots[2] as string, { latency_s: latency[2] }),
    scored("C1", "CLOSE_FALSE_POSITIVE", gots[3] as string, { latency_s: latency[3] }),
    scored("C2", "CLOSE_FALSE_POSITIVE", gots[4] as string, { latency_s: latency[4] }),
    scored("C3", "CLOSE_FALSE_POSITIVE", gots[5] as string),
  ],
});
const OK = ["RECOMMEND_BLOCK", "ESCALATE_L2", "ESCALATE_L2", "CLOSE_FALSE_POSITIVE", "ESCALATE_L2", "ERROR"];

describe("the local-mode study", () => {
  it("knows its runs by variant and tag", () => {
    expect(armOf({ variant: "lightning", tag: "a3-local-r2" })).toBe("local");
    expect(armOf({ variant: "routed", tag: "a3-default-r1" })).toBe("default");
    expect(armOf({ variant: "routed", tag: "a3-local-r1" })).toBeUndefined();
    expect(armOf({ variant: "lightning" })).toBeUndefined();
  });

  it("counts unsupported blocks only where the labels do not accept a block", () => {
    const f = runFigures(
      "x",
      result("a3-local-r1", ["RECOMMEND_BLOCK", "RECOMMEND_BLOCK", "CLOSE_FALSE_POSITIVE", ...OK.slice(3)], [1, 2, 3]),
      [],
      [],
    );
    // R1 accepts a block; R2 does not (unsupported); R3 was wrongly closed.
    expect(f).toMatchObject({
      unsupported_blocks: 1,
      not_block_cases: 5,
      wrong_closes: 1,
      risk_cases: 3,
      clears_made: 1,
      clear_cases: 3,
      unusable: 1,
    });
  });

  it("pools the runs of an arm and puts the 95% range over the pooled counts", () => {
    const runs = [1, 2, 3].map((i) =>
      runFigures(
        `run${i}`,
        result(
          `a3-local-r${i}`,
          i === 2 ? ["RECOMMEND_BLOCK", "ESCALATE_L2", "CLOSE_FALSE_POSITIVE", ...OK.slice(3)] : OK,
          [10 * i, 20, 30, 40, 50],
        ),
        [answer("decision", "local-runtime/nemotron-3.5-lightning-30b-a3b")],
        [{ body: { receipt: { cost: { actual_usd: 0.001 } } } }],
      ),
    );
    const p = poolRuns(runs);
    expect(p).toMatchObject({ runs: 3, cases: 18, wrong_closes: 1, risk_cases: 9, clears_made: 3, clear_cases: 9 });
    expect(p.wrong_range).toBe(range95(1, 9));
    expect(p.wrong_range).not.toBe(range95(1, 3));
    expect(p.unusable_range).toBe(range95(3, 18));
    // C3 has no time in any run: 15 timed cases, pooled across the runs.
    expect(p.timed_cases).toBe(15);
    expect(p.median_case_s).toBe(30);
    expect(p.calls_by_model).toEqual({ [LIGHTNING]: 3 });
    expect(p.recorded_cost).toEqual({ receipts: 3, actual_usd: 0.003 });
    expect(p.illustrative_usd).toBe(0.006);
  });

  it("is in progress until each arm has three runs, and then complete", () => {
    const one = (tag: string) => runFigures(tag, result(tag, OK, [1, 2, 3, 4, 5]), [], []);
    const some = [one("a3-local-r1"), one("a3-local-r2"), one("a3-local-r3"), one("a3-default-r1")];
    const partial = buildStudy(some, units);
    expect(partial.status).toBe("in_progress");
    expect(partial.arms.every((a) => a.pooled === null)).toBe(true);
    expect(renderDocBlock(partial, {})).toContain("in progress");
    expect(renderReadmeLine(partial, {})).toContain("4 of 6 runs exported");
    const full = buildStudy([...some, one("a3-default-r2"), one("a3-default-r3")], units);
    expect(full.status).toBe("complete");
    expect(full.arms.map((a) => a.pooled?.runs)).toEqual([3, 3]);
    expect(full.arms[0]?.runs[0]).not.toHaveProperty("case_seconds");
    expect(renderReadmeLine(full, {})).toContain("the median per case of the local-mode runs");
  });

  it("names the model that served each call, the Ollama backup apart", () => {
    expect(
      callsByModel([
        answer("decision", "nvidia/nemotron-3-ultra-550b-a55b"),
        answer("critic", "nemotron-3.5-lightning:30b", "ollama"),
        answer("policy_guard", "local-runtime/nemotron-3.5-lightning-30b-a3b"),
        { agent: "critic", action: "model_answer", provider: null, model_used: null },
        answer("decision", "rules", "fallback-rules"),
        answer("reporter", "local-runtime/nemotron-3.5-lightning-30b-a3b"),
      ]),
    ).toEqual({ [LIGHTNING]: 1, [ULTRA]: 1, [OLLAMA]: 1 });
  });

  it("labels the cost: recorded from the receipts, the other figure illustrative and not a price", () => {
    const rec = recordedCost([{ body: { receipt: { cost: { actual_usd: 0.25 } } } }, { body: { receipt: {} } }]);
    expect(rec).toEqual({ receipts: 2, actual_usd: 0.25 });
    const text = costLabel(rec, 0.0123, units);
    expect(text).toContain("USD 0.25 recorded on 2 receipts (`cost.actual_usd`)");
    expect(text).toContain("USD 0.0123 illustrative");
    expect(text).toContain("config/default.json");
    expect(text).toContain("not a price");
  });

  it("quotes the earlier model-choice study only while the study is in progress", () => {
    const s = buildStudy([], units);
    const choice = {
      ultra: {
        short: "Ultra arm",
        median_case_s: 110,
        risk_cases: 10,
        wrong_closes: 0,
        clear_cases: 10,
        clears_made: 3,
      },
      lightning: {
        short: "Lightning arm",
        median_case_s: 385,
        risk_cases: 10,
        wrong_closes: 0,
        clear_cases: 10,
        clears_made: 1,
      },
    };
    const line = renderReadmeLine(s, choice);
    expect(line).toContain("about 6 minutes per alert locally, the median per case of the model-choice study");
    expect(line).toContain("70-case local run: not measured");
    expect(renderDocBlock(s, choice)).toContain("a median of 385 s per case against 110 s");
  });
});

describe("the groups of exported runs", () => {
  it("keeps the current system and the Nemotron-alone arm apart from the recorded evaluation runs", () => {
    expect(systemNumber("heldout4-sys4-routed-20261024T024523Z")).toBe(4);
    expect(systemNumber("heldout2-sys2bnoscreen-routed-20261023T222222Z")).toBe(2);
    expect(systemNumber("routed-20261023T133311Z")).toBeUndefined();
    expect(runGroup("heldout4-sys4-routed-20261024T024523Z", "routed")).toBe("recorded");
    expect(runGroup("routed-20261023T133311Z", "routed")).toBe("recorded");
    expect(runGroup("sys5-routed-20261025T074505Z", "routed")).toBe("current-system");
    expect(runGroup("heldout4-sys12-routed-20261026T000000Z", "routed")).toBe("current-system");
    expect(runGroup("text70-nemotron_alone-20261025T093017Z", "nemotron_alone")).toBe("nemotron-alone");
    expect(runGroup("sys6-nemotron_alone-20261025T093017Z", "nemotron_alone")).toBe("nemotron-alone");
  });
});

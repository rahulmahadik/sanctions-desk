import type { Metrics, ScoredCase } from "@sanctions-desk/agents";
import { describe, expect, it } from "vitest";
import { range95 } from "../../../tools/lib/exam-figures.js";
import {
  buildStudy,
  callsByModel,
  cloudShare,
  costLabel,
  failedCalls,
  LIGHTNING,
  NOT_RUN,
  NOT_RUN_70,
  OLLAMA,
  recordedCost,
  renderCauses,
  renderDocBlock,
  renderKnownIssuesItem,
  renderReadmeLine,
  renderSummary,
  runFigures,
  servedModel,
  type TraceEvent,
  timedOutCases,
  ULTRA,
  type UnitCosts,
  unusableByCause,
} from "../../../tools/lib/local-mode.js";

/**
 * The local-mode study's documents once the study is complete (the in-progress wording is checked in
 * local-mode.test.ts): the one summary every document quotes, the causes paragraph from the result files and the
 * traces, the README line, the NEMOTRON block and the KNOWN_ISSUES item; and the small helpers behind them: which
 * model served a call, the cloud share, the order of the calls-by-model line, what counts as a failed call, and the
 * guard on a run that is not part of the study.
 */
const metrics = (total = 0) => ({ latency_s: { p50: 1 }, cost: { total, per_case: 0 } }) as Metrics;
const scored = (
  case_id: string,
  expected: string,
  got: string,
  latency_s?: number,
  extra: Partial<ScoredCase> = {},
): ScoredCase => ({
  case_id,
  group: "g",
  kind: "k",
  expected,
  got,
  acceptable: [],
  must_not: expected === "CLOSE_FALSE_POSITIVE" ? [] : ["CLOSE_FALSE_POSITIVE"],
  ...(latency_s === undefined ? {} : { latency_s }),
  ...extra,
});
const units: UnitCosts = {
  currency: "USD",
  cloudInputPerMillionTokens: 0.5,
  cloudOutputPerMillionTokens: 1.5,
  localPerMillionTokens: 0,
};
const answer = (agent: string, model_used: string, provider = "nightshift"): TraceEvent => ({
  agent,
  action: "model_answer",
  provider,
  model_used,
});
/** A model call that failed on both providers, as the trace records it (the desk then retried). */
const failed = (agent: string, nightshift: "empty" | "timeout" | "deadline" | "other"): TraceEvent => ({
  agent,
  action: "model_answer",
  provider: null,
  model_used: null,
  detail: {
    provider_errors: [
      nightshift === "timeout"
        ? { provider: "nightshift", type: "timeout", message: "request timed out after 240000 ms" }
        : {
            provider: "nightshift",
            type: "http_error",
            status: nightshift === "other" ? 500 : 502,
            message: `nightshift returned HTTP ${nightshift === "other" ? 500 : 502}`,
            body:
              nightshift === "empty"
                ? '{"error":{"message":"local-runtime/nemotron-3.5-lightning-30b-a3b_empty_response"}}'
                : nightshift === "deadline"
                  ? '{"error":{"message":"provider_deadline"}}'
                  : '{"error":{"message":"something else"}}',
          },
      {
        provider: "ollama",
        type: "bad_response",
        message: "ollama returned an empty answer (cut off by the token limit; raise maxTokens)",
      },
    ],
  },
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

/**
 * A study shaped like the real one: the local arm holds every risk case but clears nothing, one case times out in
 * every run, one answer per run cannot be read, each run has failed calls, and it is slow; the default arm clears one
 * case per run, answers every case and is quick.
 */
const measured = () => {
  const slow = (tag: string) => ({
    ...result(tag),
    cases: [
      scored("R1", "RECOMMEND_BLOCK", "RECOMMEND_BLOCK", 300),
      scored("R2", "ESCALATE_L2", "ESCALATE_L2", 280),
      scored("R3", "ESCALATE_L2", "ERROR", undefined, { error: "case timed out after 600 s" }),
      scored("C1", "CLOSE_FALSE_POSITIVE", "ESCALATE_L2", 320, { decision_unavailable: "parsing" }),
      scored("C2", "CLOSE_FALSE_POSITIVE", "NEED_MORE_INFO", 250),
      scored("C3", "CLOSE_FALSE_POSITIVE", "ESCALATE_L2", 310),
    ],
  });
  const quick = (tag: string) => ({
    ...result(tag),
    cases: [
      scored("R1", "RECOMMEND_BLOCK", "RECOMMEND_BLOCK", 30),
      scored("R2", "ESCALATE_L2", "ESCALATE_L2", 40),
      scored("R3", "ESCALATE_L2", "ESCALATE_L2", 35),
      scored("C1", "CLOSE_FALSE_POSITIVE", "CLOSE_FALSE_POSITIVE", 36),
      scored("C2", "CLOSE_FALSE_POSITIVE", "NEED_MORE_INFO", 20),
      scored("C3", "CLOSE_FALSE_POSITIVE", "ESCALATE_L2", 34),
    ],
  });
  const lightning = answer("decision", "local-runtime/nemotron-3.5-lightning-30b-a3b");
  const backup = answer("critic", "nemotron-3.5-lightning:30b", "ollama");
  const runs = [1, 2, 3].flatMap((i) => [
    runFigures(
      `local${i}`,
      slow(`a3-local-r${i}`),
      [
        lightning,
        lightning,
        backup,
        failed("decision", "empty"),
        failed("decision", "empty"),
        failed("critic", "timeout"),
      ],
      [{}, {}],
    ),
    runFigures(
      `default${i}`,
      quick(`a3-default-r${i}`),
      [
        answer("decision", "nvidia/nemotron-3-ultra-550b-a55b"),
        lightning,
        ...(i === 1 ? [failed("decision", "deadline")] : []),
      ],
      [{}, {}],
    ),
  ]);
  return buildStudy(runs, units);
};

describe("the one summary of a complete local-mode study", () => {
  it("is empty while the study is in progress", () => {
    expect(renderSummary(buildStudy([local(1)], units))).toBe("");
    expect(renderCauses(buildStudy([local(1)], units))).toBe("");
  });

  it("quotes the pooled figures, rounds the medians to whole seconds and draws the verdict from them", () => {
    const s = renderSummary(measured());
    expect(s).toBe(
      "Fully local mode (held-out v4, 3 runs, 18 cases): 0 of 9 risk cases wrongly closed and 0 of 9 model calls sent to the cloud; but 0 of 9 clears, 6 of 18 cases without a usable model answer (each held for a person) and a median of 300 s per case. With Ultra in the cloud on the same cases: 0 of 9 wrongly closed, 3 of 9 clears, every case answered, median 34 s. Fully local mode is safe but not yet practical on this laptop, which is why reasoning runs on Ultra by default.",
    );
    expect(renderSummary(measured(), { bold: true })).toMatch(/^\*\*Fully local mode\*\* \(held-out v4/);
  });

  it("says the mode is practical when it answers every case no slower than the default, and not safe after a wrong close", () => {
    expect(renderSummary(complete())).toContain(
      "but 9 of 9 clears, every case answered and a median of 30 s per case. With Ultra in the cloud on the same cases: 0 of 9 wrongly closed, 9 of 9 clears, every case answered, median 30 s. Fully local mode is safe and practical on this laptop.",
    );
    const wrong = (tag: string) => ({
      ...result(tag),
      cases: [scored("R1", "ESCALATE_L2", "CLOSE_FALSE_POSITIVE", 10), ...result(tag).cases.slice(1)],
    });
    const unsafe = buildStudy(
      [
        ...[1, 2, 3].map((i) => runFigures(`l${i}`, wrong(`a3-local-r${i}`), [], [])),
        ...[1, 2, 3].map((i) => runFigures(`d${i}`, result(`a3-default-r${i}`), [], [])),
      ],
      units,
    );
    expect(renderSummary(unsafe)).toContain("3 of 9 risk cases wrongly closed");
    expect(renderSummary(unsafe)).toContain(
      "Fully local mode is not safe on these cases, which is why reasoning runs on Ultra by default.",
    );
  });

  it("explains the unusable answers from the result files and the failed calls from the traces", () => {
    expect(renderCauses(measured())).toBe(
      "Where the fully local arm's 6 unusable answers came from: 3 cases timed out (R3 after 600 s in 3 of 3 runs) and 3 answers no decision could be read from. Behind them, 9 model calls failed on both providers and were retried: Nightshift answered HTTP 502 `empty_response` (an empty answer) 6 times and timed out 3 times; the Ollama backup then answered nothing, cut off by its token limit, 9 times. In the default arm 1 model call failed on both providers (Nightshift answered HTTP 502 `provider_deadline` once; the Ollama backup then answered nothing, cut off by its token limit, once); each was recovered by a retry.",
    );
    expect(renderCauses(complete())).toBe(
      "Every case in the fully local arm got a usable answer. No model call failed on both providers. In the default arm no model call failed on both providers.",
    );
  });
});

describe("the documents of a complete local-mode study", () => {
  it("give the doc block the summary, its pooled table, the per-run table, the cloud share, the causes and the cost line, and drop the not-run note", () => {
    const study = complete();
    const block = renderDocBlock(study, {});
    expect(block).not.toContain(NOT_RUN);
    expect(block).toContain(`**${study.label}.** ${renderSummary(study)} ${NOT_RUN_70}`);
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
    expect(block).toContain(`\n${renderCauses(study)}\n`);
    expect(block).toContain(
      "runs, traces and receipts: `eval/studies/local-mode` ([eval/studies](../eval/studies/README.md))",
    );
    expect(block).toContain("USD 0 recorded on 3 receipts (`cost.actual_usd`); USD 0.006 illustrative");
    expect(block).toContain("USD 0.003 recorded on 3 receipts (`cost.actual_usd`); USD 0.006 illustrative");
  });

  it("give the README line the one summary in bold, the 70-case limit and the two links, instead of the not-run note", () => {
    const study = measured();
    const line = renderReadmeLine(study, {});
    expect(line).not.toContain(NOT_RUN);
    expect(line).toBe(
      `- ${renderSummary(study, { bold: true })} ${NOT_RUN_70} Details: [docs/NEMOTRON.md](docs/NEMOTRON.md#fully-local-mode-every-step-on-the-laptop). How to run it: [docs/MODELS.md](docs/MODELS.md#fully-local-mode).`,
    );
  });

  it("give the KNOWN_ISSUES item the same summary and causes, the 70-case limit and the export folder", () => {
    const study = measured();
    expect(renderKnownIssuesItem(study)).toBe(
      `- ${renderSummary(study, { bold: true })} ${renderCauses(study)} ${NOT_RUN_70} Runs, traces and receipts: \`eval/studies/local-mode\` ([eval/studies](../eval/studies/README.md)); the tables: [NEMOTRON.md](NEMOTRON.md#fully-local-mode-every-step-on-the-laptop); how to run it: [MODELS.md](MODELS.md#fully-local-mode).`,
    );
    expect(renderKnownIssuesItem(buildStudy([], units))).toBe(
      `- **Fully local mode on held-out v4:** not measured yet (every step on Lightning on the laptop; how to run it: [MODELS.md](MODELS.md#fully-local-mode)). ${NOT_RUN}`,
    );
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

  it("count a failed call once, by what each provider answered, and only for the model steps", () => {
    expect(
      failedCalls([
        failed("decision", "empty"),
        failed("critic", "timeout"),
        failed("challenger", "deadline"),
        failed("decision", "other"),
        failed("reporter", "empty"),
        answer("decision", "local-runtime/nemotron-3.5-lightning-30b-a3b"),
        {
          agent: "decision",
          action: "model_answer",
          provider: null,
          model_used: null,
          detail: { provider_errors: [] },
        },
      ]),
    ).toEqual({
      calls: 4,
      nightshift_empty_response: 1,
      nightshift_timeout: 1,
      nightshift_provider_deadline: 1,
      nightshift_other: 1,
      ollama_token_limit: 4,
      ollama_other: 0,
    });
  });

  it("read the cases that timed out and the cause of each unusable answer from the result file", () => {
    const cases = [
      scored("A", "ESCALATE_L2", "ERROR", undefined, { error: "case timed out after 600 s" }),
      scored("B", "ESCALATE_L2", "ERROR", undefined, { error: "something broke" }),
      scored("C", "ESCALATE_L2", "ESCALATE_L2", 5, { decision_unavailable: "parsing" }),
      scored("D", "ESCALATE_L2", "ESCALATE_L2", 5, { decision_unavailable: "provider" }),
      scored("E", "ESCALATE_L2", "ESCALATE_L2", 5),
    ];
    expect(timedOutCases(cases)).toEqual([{ case_id: "A", after_s: 600 }]);
    expect(unusableByCause(cases)).toEqual({ timeout: 1, parsing: 1, provider: 1, withheld: 0, other: 1 });
    // The pooled figures add the causes and count a case's time-outs across the runs.
    const pooled = measured().arms[0]?.pooled;
    expect(pooled?.unusable_by_cause).toEqual({ timeout: 3, parsing: 3, provider: 0, withheld: 0, other: 0 });
    expect(pooled?.timed_out).toEqual([{ case_id: "R3", after_s: 600, runs: 3 }]);
    expect(pooled?.failed_calls.calls).toBe(9);
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

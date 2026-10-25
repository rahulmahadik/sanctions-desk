import type { HeldoutRound, Metrics, RoundCell, ScoredCase } from "@sanctions-desk/agents";
import { describe, expect, it } from "vitest";
import {
  examArms,
  examFigures,
  heldoutSummary,
  heldoutTotals,
  heldoutTotalsTable,
  rulesFraming,
} from "../../../tools/lib/exam-figures.js";

const metrics = { latency_s: { p50: 1 } } as Metrics;
const scored = (case_id: string, expected: string, got: string, extra: Partial<ScoredCase> = {}): ScoredCase =>
  ({
    case_id,
    expected,
    got,
    acceptable: [],
    must_not: expected === "CLOSE_FALSE_POSITIVE" ? [] : ["CLOSE_FALSE_POSITIVE"],
    ...extra,
  }) as ScoredCase;

describe("the 70-case figures", () => {
  it("counts an unsupported block only where the labels do not accept a block", () => {
    const f = examFigures({
      metrics,
      cases: [
        scored("A", "RECOMMEND_BLOCK", "RECOMMEND_BLOCK"),
        scored("B", "ESCALATE_L2", "RECOMMEND_BLOCK", { acceptable: ["RECOMMEND_BLOCK"] }),
        scored("C", "ESCALATE_L2", "RECOMMEND_BLOCK"),
        scored("D", "CLOSE_FALSE_POSITIVE", "CLOSE_FALSE_POSITIVE"),
        scored("E", "ESCALATE_L2", "CLOSE_FALSE_POSITIVE"),
      ],
    });
    expect(f).toMatchObject({ blocks: 3, unsupportedBlocks: 1, notBlockCases: 3, wrong: 1, risk: 4, made: 1 });
  });

  it("picks the newest run of each arm, and keeps the Nemotron alone arms apart by the free text", () => {
    const run = (file: string, variant: string, extra: object = {}) => ({
      variant,
      started_at: file,
      cases: [scored("A", "ESCALATE_L2", "ESCALATE_L2")],
      metrics,
      file,
      ...extra,
    });
    const arms = examArms(
      [
        run("1", "routed"),
        run("2", "routed"),
        run("3", "routed", { system: "sys5" }),
        run("4", "routed", { exam: "heldout" }),
        run("5", "nemotron_alone", { features: { with_free_text: true } }),
      ],
      new Map(),
    );
    expect(arms.first?.file).toBe("2");
    expect(arms.beforeBlockFix?.file).toBe("3");
    expect(arms.current).toBeUndefined();
    expect(arms.aloneWith?.file).toBe("5");
    expect(arms.aloneWithout).toBeUndefined();
  });
});

describe("the rules-versus-full-system framing", () => {
  const cell = (risk: number, wrong: number, clears: number, made: number) =>
    ({ risk, wrong_closes: wrong, clears, clears_made: made }) as RoundCell;
  const round = (id: string, routed: RoundCell, rules: RoundCell, blind = true) =>
    ({ id, blind, cells: { routed, rules } }) as unknown as HeldoutRound;

  it("sums the blind rounds, and gives the totals without v2", () => {
    const t = heldoutTotals([
      round("v1", cell(10, 1, 4, 0), cell(10, 3, 4, 2)),
      round("v2", cell(5, 0, 2, 0), cell(5, 2, 2, 2)),
      round("v2-rerun", cell(5, 0, 2, 0), cell(5, 2, 2, 2), false),
    ]);
    expect(t.all).toMatchObject({ risk: 15, fullWrong: 1, rulesWrong: 5, clearCases: 6, rulesClears: 4 });
    expect(t.noV2).toMatchObject({ risk: 10, fullWrong: 1, rulesWrong: 3 });
    const exam = examFigures({ metrics, cases: [scored("A", "ESCALATE_L2", "ESCALATE_L2")] });
    expect(rulesFraming(exam, t)).toContain(
      "the rules wrongly closed 5 of 15 risk cases against 1 of 15 for the full system (without v2: 3 of 10 against 1 of 10).",
    );
    expect(heldoutTotalsTable(heldoutSummary(t))).toHaveLength(8);
    expect(rulesFraming(undefined, t)).toBe("");
  });
});

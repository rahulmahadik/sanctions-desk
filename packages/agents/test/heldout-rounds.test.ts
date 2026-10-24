import { describe, expect, it } from "vitest";
import type { ScoredCase } from "../src/eval.js";
import { heldoutRounds, roundCell, type SavedResult } from "../src/heldout-rounds.js";

const risk = (id: string, got: string): ScoredCase =>
  ({ case_id: id, expected: "ESCALATE_L2", acceptable: [], must_not: ["CLOSE_FALSE_POSITIVE"], got }) as never;
const clear = (id: string, got: string): ScoredCase =>
  ({ case_id: id, expected: "CLOSE_FALSE_POSITIVE", acceptable: [], must_not: [], got }) as never;

const run = (over: Partial<SavedResult>, cases: ScoredCase[]): SavedResult => ({
  variant: "routed",
  started_at: "2026-10-23T00:00:00Z",
  cases,
  ...over,
});

describe("held-out rounds", () => {
  it("counts wrong closes with their ids and clears made, leaving out cases that errored", () => {
    const cell = roundCell(
      run({}, [
        risk("HO-1", "CLOSE_FALSE_POSITIVE"),
        risk("HO-2", "ESCALATE_L2"),
        { ...risk("HO-3", "CLOSE_FALSE_POSITIVE"), error: "boom" } as never,
        clear("HO-4", "CLOSE_FALSE_POSITIVE"),
        clear("HO-5", "NEED_MORE_INFO"),
      ]),
    );
    expect(cell).toMatchObject({ risk: 2, wrong_closes: 1, wrong_close_ids: ["HO-1"], clears: 2, clears_made: 1 });
    expect(cell.text).toBe("1 of 2 risks closed (HO-1); 1 of 2 clears");
  });

  it("takes each round's own system for the full and single runs, untagged runs for the baselines, newest first", () => {
    const rounds = heldoutRounds([
      run({ exam: "heldout4", system: "sys4" }, [risk("A", "ESCALATE_L2")]),
      run({ exam: "heldout4", variant: "rules", started_at: "2026-10-23T01:00:00Z" }, [risk("A", "ESCALATE_L2")]),
      run({ exam: "heldout4", variant: "rules", started_at: "2026-10-23T02:00:00Z" }, [
        risk("A", "CLOSE_FALSE_POSITIVE"),
      ]),
      // A partial run and another system's run never count.
      run({ exam: "heldout4", variant: "fuzzy", tag: "smoke" }, [risk("A", "ESCALATE_L2")]),
      run({ exam: "heldout4", system: "sys3", variant: "single" }, [risk("A", "ESCALATE_L2")]),
    ]);
    const v4 = rounds.find((r) => r.id === "v4");
    expect(v4?.cells.routed?.wrong_closes).toBe(0);
    expect(v4?.cells.rules?.wrong_close_ids).toEqual(["A"]);
    expect(v4?.cells.fuzzy).toBeNull();
    expect(v4?.cells.single).toBeNull();
    expect(rounds.map((r) => r.id)).toEqual(["v1", "v2", "v2-rerun", "v3", "v4"]);
  });

  it("never reports single mode for the first held-out round, whose system has no version tag", () => {
    const rounds = heldoutRounds([run({ exam: "heldout", variant: "single" }, [risk("A", "ESCALATE_L2")])]);
    expect(rounds[0]?.cells.single).toBeNull();
  });
});

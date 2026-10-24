/**
 * Every held-out round as it was run, with the baselines on the same frozen cases. The README and the review desk's
 * test-scores screen both build their table from this, so they always show the same numbers, read from the saved
 * result files. A round or a baseline that was never run says so; nothing is filled in.
 */
import type { ScoredCase } from "./eval.js";

/** One saved result file, as `eval/results/*.json` holds it. */
export interface SavedResult {
  file?: string;
  exam?: string;
  system?: string;
  variant: string;
  tag?: string;
  started_at?: string;
  selection?: { kinds?: unknown; groups?: unknown; limit?: unknown };
  cases?: ScoredCase[];
}

/** The outcome of one run on one round's cases. */
export interface RoundCell {
  file: string;
  risk: number;
  wrong_closes: number;
  wrong_close_ids: string[];
  clears: number;
  clears_made: number;
  acceptable: number;
  total: number;
  /** The cell in words, as the README and the screen print it. */
  text: string;
}

export const ROUND_COLUMNS = ["routed", "single", "rules", "fuzzy", "escalate_all"] as const;
export type RoundColumn = (typeof ROUND_COLUMNS)[number];

export const ROUND_COLUMN_LABEL: Record<RoundColumn, string> = {
  routed: "Full system",
  single: "Single (no critic, no challenger)",
  rules: "Deterministic rules",
  fuzzy: "Name match",
  escalate_all: "Escalate everything",
};

export interface HeldoutRound {
  id: string;
  label: string;
  /** The system version the round tested, and the commit its review code came from. */
  system: string;
  commit: string;
  blind: boolean;
  cells: Record<RoundColumn, RoundCell | null>;
}

/** The rounds in the order they were run. `system` is the result files' system tag; the first system has none. */
const ROUNDS: ReadonlyArray<{
  id: string;
  label: string;
  exam: string;
  system?: string;
  name: string;
  commit: string;
  blind: boolean;
}> = [
  { id: "v1", label: "Held-out v1 (30 cases)", exam: "heldout", name: "first system", commit: "f9f3212", blind: true },
  {
    id: "v2",
    label: "Held-out v2 (19 cases)",
    exam: "heldout2",
    system: "sys2",
    name: "screener added; it failed on every case",
    commit: "da7aff4",
    blind: true,
  },
  {
    id: "v2-rerun",
    label: "Held-out v2, re-run after an infrastructure fix",
    exam: "heldout2",
    system: "sys2b",
    name: "screener answering in plain JSON",
    commit: "f6ed38a",
    blind: false,
  },
  {
    id: "v3",
    label: "Held-out v3 (12 cases)",
    exam: "heldout3",
    system: "sys3",
    name: "span grounding",
    commit: "517f798",
    blind: true,
  },
  {
    id: "v4",
    label: "Held-out v4 (12 cases, last round)",
    exam: "heldout4",
    system: "sys4",
    name: "fails closed",
    commit: "ce1db95",
    blind: true,
  },
];

const whole = (r: SavedResult): boolean =>
  !r.tag && !r.selection?.kinds && !r.selection?.groups && !r.selection?.limit && Array.isArray(r.cases);

const closed = (c: ScoredCase): boolean => c.got === "CLOSE_FALSE_POSITIVE";

/** Wrong closes and clears made, the same way the exam report counts them: cases that errored are left out. */
export function roundCell(r: SavedResult): RoundCell {
  const cases = (r.cases ?? []).filter((c) => (c as { error?: unknown }).error === undefined);
  const risk = cases.filter((c) => c.must_not.includes("CLOSE_FALSE_POSITIVE"));
  const clears = cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE");
  const wrong = risk.filter(closed);
  const cell = {
    file: r.file ?? "",
    risk: risk.length,
    wrong_closes: wrong.length,
    wrong_close_ids: wrong.map((c) => c.case_id),
    clears: clears.length,
    clears_made: clears.filter(closed).length,
    acceptable: cases.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length,
    total: (r.cases ?? []).length,
  };
  return { ...cell, text: roundCellText(cell) };
}

/**
 * Build every round from the saved results. The newest complete run wins where a variant was run more than once;
 * the full system and single mode come from the round's own system version, the baselines from runs with no system
 * tag on the same cases.
 */
export function heldoutRounds(results: readonly SavedResult[]): HeldoutRound[] {
  const newest = (pick: (r: SavedResult) => boolean): RoundCell | null => {
    const runs = results.filter((r) => whole(r) && pick(r));
    const last = runs.sort((a, b) => (a.started_at ?? a.file ?? "").localeCompare(b.started_at ?? b.file ?? "")).at(-1);
    return last ? roundCell(last) : null;
  };
  return ROUNDS.map((round) => {
    const own = (variant: string) =>
      newest((r) => r.exam === round.exam && r.system === round.system && r.variant === variant);
    const baseline = (variant: string) =>
      newest((r) => r.exam === round.exam && r.system === undefined && r.variant === variant);
    return {
      id: round.id,
      label: round.label,
      system: round.name,
      commit: round.commit,
      blind: round.blind,
      cells: {
        routed: own("routed"),
        // Single mode was run on a round only with that round's own system version.
        single: round.system ? own("single") : null,
        rules: baseline("rules"),
        fuzzy: baseline("fuzzy"),
        escalate_all: baseline("escalate_all"),
      },
    };
  });
}

/** One cell as words, the same in the README and on the screen. */
export function roundCellText(cell: Omit<RoundCell, "text"> | null): string {
  if (!cell) return "not run";
  const wrong =
    cell.wrong_closes === 0
      ? `0 of ${cell.risk} risks closed`
      : `${cell.wrong_closes} of ${cell.risk} risks closed (${cell.wrong_close_ids.join(", ")})`;
  return `${wrong}; ${cell.clears_made} of ${cell.clears} clears`;
}

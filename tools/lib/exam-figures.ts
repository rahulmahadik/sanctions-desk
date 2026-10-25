/**
 * The figures of the 70-case runs and the held-out totals that more than one generated document quotes: the
 * five-ways table of eval/REPORT.md (tools/exam-report.ts) and the per-arm table of the Nemotron scorecard
 * (tools/nemotron-scorecard.ts). One computation, so the two can never disagree; each caller chooses which result
 * files and run exports it reads (the report reads every saved result, the scorecard only files tracked by git).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type HeldoutRound, type Metrics, type ScoredCase, summarise } from "@sanctions-desk/agents";
import { wilson95 } from "@sanctions-desk/shared";

/** A saved exam result as the report tools read it, with the file it came from. */
export interface ExamRun {
  variant: string;
  /** The version of the system under test (for example sys5); absent for the first system. */
  system?: string;
  /** "heldout", "heldout2", ... for a held-out run; absent for the 70-case exam. */
  exam?: string;
  tag?: string;
  selection?: { groups?: string[]; kinds?: number; limit?: number };
  features?: { with_free_text?: boolean };
  started_at: string;
  cases: ScoredCase[];
  metrics: Metrics;
  file: string;
}

export interface LabelSet {
  expected: string;
  acceptable: string[];
  must_not: string[];
}

/** Score a saved run against the given labels (the committed exam), so a label that changed applies to every run. */
export function relabel<R extends { cases: ScoredCase[]; metrics: Metrics }>(
  r: R,
  labels: ReadonlyMap<string, LabelSet>,
): R {
  const cases = r.cases.map((c) => {
    const l = labels.get(c.case_id);
    return l ? { ...c, expected: l.expected, acceptable: l.acceptable, must_not: l.must_not } : c;
  });
  return { ...r, cases, metrics: summarise(cases) };
}

export const riskOf = (cases: readonly ScoredCase[]) =>
  cases.filter((c) => c.must_not.includes("CLOSE_FALSE_POSITIVE"));
export const closed = (c: ScoredCase) => c.got === "CLOSE_FALSE_POSITIVE";
export const noAnswer = (c: ScoredCase) => c.got === "ERROR" || c.decision_unavailable !== undefined;
/** Whether the labels of a case accept a block recommendation (its expected outcome or an acceptable one). */
export const blockAccepted = (c: ScoredCase): boolean =>
  c.expected === "RECOMMEND_BLOCK" || c.acceptable.includes("RECOMMEND_BLOCK");
/** "0–8%": the 95% Wilson score interval of k of n, in whole percent. */
export const range95 = (k: number, n: number) => {
  const { low, high } = wilson95(k, n);
  return `${low}–${high}%`;
};

/** The figures of one 70-case run that the five-ways table, the block-fix comparison and the scorecard quote. */
export function examFigures(r: { cases: readonly ScoredCase[]; metrics: Metrics }) {
  const risk = riskOf(r.cases);
  const clears = r.cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE");
  const count = (o: string) => r.cases.filter((c) => c.got === o).length;
  return {
    wrong: risk.filter(closed).length,
    risk: risk.length,
    made: clears.filter(closed).length,
    clears: clears.length,
    escalated: count("ESCALATE_L2"),
    blocks: count("RECOMMEND_BLOCK"),
    moreInfo: count("NEED_MORE_INFO"),
    unusable: r.cases.filter(noAnswer).length,
    /** Block recommendations on cases whose labels do not accept a block: an accusation the case does not support. */
    unsupportedBlocks: r.cases.filter((c) => c.got === "RECOMMEND_BLOCK" && !blockAccepted(c)).length,
    notBlockCases: r.cases.filter((c) => !blockAccepted(c)).length,
    median: r.metrics.latency_s.p50,
    cases: r.cases.length,
  };
}
export type ExamFigures = ReturnType<typeof examFigures>;

/**
 * Which model produced the decision answer that was used, per case, from the run's exported trace: the last decision
 * answer the step accepted. Lightning on a retry is the desk's fast-lane fallback after an unusable or failed first
 * answer; Lightning on a first try is Nightshift's router choosing it; the Ollama backup has no receipt. `runDirs` are
 * the run export folders (each with run-meta.json and trace.jsonl.gz) the caller allows; the run is matched by its
 * start time.
 */
export function answerSources(r: Pick<ExamRun, "variant" | "started_at" | "cases">, runDirs: readonly string[]) {
  if (!["routed", "single", "no_memory", "nemotron_alone"].includes(r.variant)) return "no model";
  const dir = runDirs.find((d) => {
    const meta = join(d, "run-meta.json");
    return (
      existsSync(meta) &&
      (JSON.parse(readFileSync(meta, "utf8")) as { started_at?: string }).started_at === r.started_at
    );
  });
  if (!dir || !existsSync(join(dir, "trace.jsonl.gz"))) return "trace not exported";
  const used = new Map<string, { model?: string; retry?: number; requested?: string }>();
  for (const line of gunzipSync(readFileSync(join(dir, "trace.jsonl.gz")))
    .toString("utf8")
    .split("\n")) {
    if (!line.includes('"decision"') || !line.includes('"model_answer"')) continue;
    const e = JSON.parse(line) as {
      case_id: string;
      agent: string;
      action: string;
      status: string;
      model_used?: string;
      retry_count?: number;
      model_requested?: string;
    };
    if (e.agent === "decision" && e.action === "model_answer" && e.status === "ok")
      used.set(e.case_id, { model: e.model_used, retry: e.retry_count, requested: e.model_requested });
  }
  const n = { ultra: 0, retry: 0, router: 0, ollama: 0, none: 0 };
  for (const c of r.cases) {
    const u = used.get(c.case_id);
    if (!u?.model) n.none += 1;
    else if (u.model.includes("ultra")) n.ultra += 1;
    else if (u.model.includes("lightning:")) n.ollama += 1;
    else if ((u.retry ?? 0) > 0 || u.requested === "meterless/fast") n.retry += 1;
    else n.router += 1;
  }
  return [
    `Ultra ${n.ultra}`,
    n.retry ? `Lightning (fast-lane retry) ${n.retry}` : "",
    n.router ? `Lightning (router) ${n.router}` : "",
    n.ollama ? `Ollama backup ${n.ollama}` : "",
    n.none ? `none ${n.none}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

// ---- the arms of the 70-case comparison ---------------------------------------------------------------------------

const whole = (r: ExamRun) =>
  r.exam === undefined && r.tag === undefined && !r.selection?.kinds && !r.selection?.groups && !r.selection?.limit;

/** The newest complete 70-case run of each arm, scored against `labels`. `runs` are in file-name (time) order. */
export function examArms<R extends ExamRun>(runs: readonly R[], labels: ReadonlyMap<string, LabelSet>) {
  const newest = (pick: (r: R) => boolean): R | undefined => {
    const r = runs.filter(pick).at(-1);
    return r ? relabel(r, labels) : undefined;
  };
  const baseline = (variant: string) => newest((r) => r.variant === variant && r.system === undefined && whole(r));
  const system = (id: string) => newest((r) => r.variant === "routed" && r.system === id && whole(r));
  const alone = (withText: boolean) =>
    newest(
      (r) =>
        r.variant === "nemotron_alone" &&
        r.exam === undefined &&
        !r.selection?.limit &&
        (r.features?.with_free_text === true) === withText,
    );
  return {
    first: baseline("routed"),
    /** sys5: the current system on the code before the block fix (commit 16e0dae). */
    beforeBlockFix: system("sys5"),
    /** sys6: the current system on the fixed code. */
    current: system("sys6"),
    rules: baseline("rules"),
    fuzzy: baseline("fuzzy"),
    aloneWithout: alone(false),
    aloneWith: alone(true),
  };
}
export type ExamArms<R extends ExamRun = ExamRun> = ReturnType<typeof examArms<R>>;

/** The rows of the 70-case comparison, labelled and in order; a run that does not exist yet is undefined. */
export function armRows<R extends ExamRun>(a: ExamArms<R>): Array<{ label: string; run: R | undefined }> {
  return [
    { label: "Full system, first system", run: a.first },
    { label: "Full system, current system before the block fix", run: a.beforeBlockFix },
    { label: "Full system, current system", run: a.current },
    { label: "Deterministic rules", run: a.rules },
    { label: "Name-match rules baseline", run: a.fuzzy },
    { label: "Nemotron alone, without the free text", run: a.aloneWithout },
    { label: "Nemotron alone, with the free text (sent to the cloud)", run: a.aloneWith },
  ];
}

// ---- held-out totals and the rules-versus-full-system framing -----------------------------------------------------

/** Totals over the blind held-out rounds (from heldoutRounds), and the same without v2, where the screener failed. */
export function heldoutTotals(rounds: readonly HeldoutRound[]) {
  const blind = rounds.filter((r) => r.blind && r.cells.routed);
  const sum = (rs: readonly HeldoutRound[]) => {
    const add = (pick: (r: HeldoutRound) => number) => rs.reduce((n, r) => n + pick(r), 0);
    return {
      risk: add((r) => r.cells.rules?.risk ?? r.cells.routed?.risk ?? 0),
      clearCases: add((r) => r.cells.routed?.clears ?? 0),
      fullWrong: add((r) => r.cells.routed?.wrong_closes ?? 0),
      fullClears: add((r) => r.cells.routed?.clears_made ?? 0),
      rulesWrong: add((r) => r.cells.rules?.wrong_closes ?? 0),
      rulesClears: add((r) => r.cells.rules?.clears_made ?? 0),
    };
  };
  const withoutV2 = blind.filter((r) => r.id !== "v2");
  return { blind, all: sum(blind), noV2: sum(withoutV2), hasV2: withoutV2.length < blind.length };
}
export type HeldoutTotals = ReturnType<typeof heldoutTotals>;
export type HeldoutSums = HeldoutTotals["all"];
/** The totals as data files keep them: the number of blind rounds, the sums, and the sums without v2 (null without v2). */
export interface HeldoutSummary {
  rounds: number;
  all: HeldoutSums;
  without_v2: HeldoutSums | null;
}
export const heldoutSummary = (t: HeldoutTotals): HeldoutSummary => ({
  rounds: t.blind.length,
  all: t.all,
  without_v2: t.hasV2 ? t.noV2 : null,
});

/** Why the rules look exact on the 70 cases and what they did on the held-out rounds, in one paragraph. */
export function rulesFraming(rules: ExamFigures | undefined, t: HeldoutTotals): string {
  if (!rules || t.blind.length === 0) return "";
  const v2 = t.hasV2
    ? ` (without v2: ${t.noV2.rulesWrong} of ${t.noV2.risk} against ${t.noV2.fullWrong} of ${t.noV2.risk})`
    : "";
  return `**The rules on home ground.** The 70 exam cases are labelled from the same definitions the rules use, so the rules have a home advantage here (${rules.wrong} of ${rules.risk} risk cases wrongly closed, ${rules.made} of ${rules.clears} clears). On the frozen held-out rounds, written without those rules, the rules wrongly closed ${t.all.rulesWrong} of ${t.all.risk} risk cases against ${t.all.fullWrong} of ${t.all.risk} for the full system${v2}.`;
}

/** The held-out totals as a small table, to sit under a 70-case table. */
export function heldoutTotalsTable(t: HeldoutSummary): string[] {
  if (t.rounds === 0) return [];
  const v2 = t.without_v2;
  const row = (label: string, wrong: number, risk: number, made: number, clears: number) =>
    `| ${label} | ${wrong} of ${risk} (${range95(wrong, risk)}) | ${made} of ${clears} (${range95(made, clears)}) |`;
  return [
    `**Blind held-out rounds, totals** (${t.rounds} rounds, cases the rules were not written for; each round ran the system of its time, one run each; per round in the held-out table):`,
    "",
    "| System | Risk cases wrongly closed | Clear cases closed |",
    "|---|---:|---:|",
    row("Full system", t.all.fullWrong, t.all.risk, t.all.fullClears, t.all.clearCases),
    row("Deterministic rules", t.all.rulesWrong, t.all.risk, t.all.rulesClears, t.all.clearCases),
    ...(v2
      ? [
          row("Full system, without v2", v2.fullWrong, v2.risk, v2.fullClears, v2.clearCases),
          row("Deterministic rules, without v2", v2.rulesWrong, v2.risk, v2.rulesClears, v2.clearCases),
        ]
      : []),
  ];
}

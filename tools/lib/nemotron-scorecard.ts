/**
 * The Nemotron scorecard: which model does each step and where, what each model did in the recorded runs (calls,
 * median time and tokens, the cost its receipts record), the share of calls answered on the laptop, the calibration of
 * every arm that gave a confidence, and the safety-guard results with 95% ranges. Everything is computed from files
 * tracked by git (`git ls-files`), so a local run and CI read the same inputs; nothing calls a service.
 *
 * Written by tools/nemotron-scorecard.ts (npm run nemotron:scorecard); the functions here are pure apart from reading
 * the committed files, so the tests can check them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { heldoutRounds, type SavedResult } from "@sanctions-desk/agents";
import { countWithInterval, median, wilson95 } from "@sanctions-desk/shared";
import {
  answerSources,
  armRows,
  type ExamRun,
  examArms,
  examFigures,
  type HeldoutSummary,
  type HeldoutTotals,
  heldoutSummary,
  heldoutTotals,
  heldoutTotalsTable,
  type LabelSet,
  range95,
  rulesFraming,
} from "./exam-figures.js";
import { receiptFigure, receiptSentence } from "./receipt-figure.js";
import { RUN_GROUP_ORDER, type RunGroupId, runGroup } from "./run-groups.js";

// ---- the steps (the why text is the start of the "Why this model" cell in docs/NEMOTRON.md; checked on build) ----

export const LIGHTNING = "Nemotron 3.5 Lightning 30B";
export const ULTRA = "Nemotron 3 Ultra 550B";
export const OLLAMA = "Ollama backup (Lightning, no receipt)";
/** What the step tables add to Ultra: the desk pins the mode it asks for, not the model that serves it. */
export const ROUTER_NOTE = "in most calls (the router chooses)";
const LAPTOP = "Local laptop";
const CLOUD = "Cloud";

export interface StepRow {
  step: string;
  model: string;
  where: string;
  why: string;
}

export const STEPS: readonly StepRow[] = [
  {
    step: "Safety guard (inbound)",
    model: LIGHTNING,
    where: LAPTOP,
    why: "It reads the free text of the data to flag instructions aimed at the reviewer, so the text must stay on the machine",
  },
  {
    step: "Free-text screener",
    model: LIGHTNING,
    where: LAPTOP,
    why: "It reads customer notes, payment references and list remarks and returns risk signals with the exact text span",
  },
  {
    step: "Decision",
    model: ULTRA,
    where: CLOUD,
    why: "Applying the approved definitions to many fields at once and citing the rows it rests on is the hardest step",
  },
  {
    step: "Critic",
    model: ULTRA,
    where: CLOUD,
    why: "It checks the recommendation against the evidence after code has re-read every cited fact from Zetaris",
  },
  { step: "Challenger", model: ULTRA, where: CLOUD, why: "It argues against a close before it can stand" },
  {
    step: "Safety guard (outbound drafts)",
    model: LIGHTNING,
    where: LAPTOP,
    why: "It checks a draft meant for a customer for tipping-off wording, on top of fixed patterns",
  },
  {
    step: "Backup when Nightshift cannot answer",
    model: `${LIGHTNING} (local Ollama)`,
    where: LAPTOP,
    why: "Keeps a step answering when Nightshift fails; the same model as the local steps",
  },
];

/** Throws unless each step's row in the doc's "Which model does each step" table names its model and starts its why. */
export function checkStepsAgainstDoc(doc: string): void {
  const rest = doc.replace(BLOCK_RE, "");
  for (const s of STEPS) {
    const row = rest.split("\n").find((l) => l.startsWith(`| ${s.step} `));
    if (!row) throw new Error(`docs/NEMOTRON.md has no row for "${s.step}" in "Which model does each step"`);
    const cells = row.split("|").map((c) => c.trim());
    if (!cells[2]?.startsWith(s.model.replace(" (local Ollama)", "")))
      throw new Error(`docs/NEMOTRON.md names another model for "${s.step}": ${cells[2]}`);
    if (!cells[4]?.startsWith(s.why))
      throw new Error(`the why of "${s.step}" no longer matches docs/NEMOTRON.md; update STEPS in tools/lib`);
  }
}

// ---- reading tracked files -----------------------------------------------------------------------------------

/** Paths tracked by git under `prefix`, relative to `root`. */
export function tracked(root: string, prefix: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", prefix], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .sort();
}
const readJson = <T>(root: string, rel: string): T => JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
const jsonl = (root: string, rel: string): unknown[] =>
  gunzipSync(readFileSync(join(root, rel)))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

// ---- per model -------------------------------------------------------------------------------------------------

interface TraceEvent {
  agent: string;
  action: string;
  provider?: string;
  model_used?: string;
  latency_ms?: number | string;
  tokens_in?: number | string;
  tokens_out?: number | string;
}

/** The five steps that call a model (the same set as npm run receipt:stats). */
const MODEL_STEPS = new Set(["policy_guard", "screener", "decision", "critic", "challenger"]);
const modelOf = (m: string, provider?: string): string =>
  provider === "ollama" ? OLLAMA : /ultra/i.test(m) ? ULTRA : /lightning/i.test(m) ? LIGHTNING : m;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? Number.NaN));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface ModelRow {
  model: string;
  where: string;
  calls: number;
  median_latency_s: number;
  median_tokens_in: number;
  median_tokens_out: number;
  /** What the signed receipts record as the cost of the calls; null when the calls have no receipt. */
  cost: { receipts: number; actual_usd_total: number } | null;
}

export interface ModelStats {
  runs: number;
  models: ModelRow[];
  local_share: { local_calls: number; all_calls: number; share: number };
}

/** The run folders under eval/runs (tracked by git) whose group is `group` (tools/lib/run-groups.ts). */
export function runFoldersIn(root: string, group: RunGroupId): string[] {
  return tracked(root, "eval/runs")
    .filter((f) => f.endsWith("/run-meta.json"))
    .filter((f) => {
      const meta = readJson<{ run_id?: string; variant: string }>(root, f);
      return runGroup(meta.run_id ?? (f.split("/").at(-2) as string), meta.variant) === group;
    })
    .map((f) => f.slice(0, -"/run-meta.json".length));
}

/**
 * Per model, over the exported runs of one group in eval/runs (the recorded evaluation runs unless told otherwise):
 * the trace events and the receipts of each run.
 */
export function modelStats(root: string, group: RunGroupId = "recorded"): ModelStats {
  const folders = new Set(runFoldersIn(root, group));
  const files = tracked(root, "eval/runs").filter((f) => folders.has(f.split("/").slice(0, -1).join("/")));
  const traces = files.filter((f) => f.endsWith("/trace.jsonl.gz"));
  const cells = new Map<string, { lat: number[]; tin: number[]; tout: number[]; calls: number }>();
  for (const t of traces) {
    for (const e of jsonl(root, t) as TraceEvent[]) {
      if (e.action !== "model_answer" || !MODEL_STEPS.has(e.agent)) continue;
      if (!e.provider || !e.model_used || e.provider === "fallback-rules") continue;
      const m = modelOf(e.model_used, e.provider);
      const c = cells.get(m) ?? { lat: [], tin: [], tout: [], calls: 0 };
      c.calls += 1;
      if (Number.isFinite(num(e.latency_ms))) c.lat.push(num(e.latency_ms) / 1000);
      if (Number.isFinite(num(e.tokens_in))) c.tin.push(num(e.tokens_in));
      if (Number.isFinite(num(e.tokens_out))) c.tout.push(num(e.tokens_out));
      cells.set(m, c);
    }
  }
  const cost = new Map<string, { receipts: number; actual_usd_total: number }>();
  for (const r of files.filter((f) => f.endsWith("/receipts.jsonl.gz"))) {
    for (const env of jsonl(root, r) as Array<{
      body?: { receipt?: { winning_route?: { model?: string }; cost?: { actual_usd?: number } } };
    }>) {
      const rc = env.body?.receipt;
      const model = rc?.winning_route?.model;
      if (!model || typeof rc?.cost?.actual_usd !== "number") continue;
      const m = modelOf(model);
      const c = cost.get(m) ?? { receipts: 0, actual_usd_total: 0 };
      c.receipts += 1;
      c.actual_usd_total += rc.cost.actual_usd;
      cost.set(m, c);
    }
  }
  const order = [LIGHTNING, ULTRA, OLLAMA];
  const models = [...cells]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([model, c]) => {
      const k = cost.get(model);
      return {
        model,
        where: model === ULTRA ? CLOUD : LAPTOP,
        calls: c.calls,
        median_latency_s: round1(median(c.lat)),
        median_tokens_in: Math.round(median(c.tin)),
        median_tokens_out: Math.round(median(c.tout)),
        cost: k ? { receipts: k.receipts, actual_usd_total: round3(k.actual_usd_total) } : null,
      };
    });
  const all = models.reduce((t, m) => t + m.calls, 0);
  const local = models.filter((m) => m.where === LAPTOP).reduce((t, m) => t + m.calls, 0);
  return {
    runs: traces.length,
    models,
    local_share: { local_calls: local, all_calls: all, share: all ? round3(local / all) : 0 },
  };
}

// ---- which model answered the reasoning steps, per run ------------------------------------------------------------

/** The reasoning steps and the lane each asks for (the mode the desk pins; the serving model is Nightshift's choice). */
export const REASONING_LANES = { decision: "deep", critic: "judge", challenger: "deep" } as const;
export type ReasoningStep = keyof typeof REASONING_LANES;

/**
 * Who answered one step's calls in one run. `nightshift` is every answer Nightshift served (each has a signed receipt);
 * it splits into `ultra` and the three Lightning kinds. `ollama` answers come from the backup and have no receipt.
 */
export interface StepShare {
  nightshift: number;
  ultra: number;
  /** Lightning on the desk's fast-lane retry after an unusable or failed first try (retry_count >= 1, meterless/fast). */
  lightning_retry: number;
  /** Lightning on the step's own lane where Nightshift's router predicted Ultra but Lightning won a hedged race. */
  lightning_hedged: number;
  /** Lightning on the step's own lane for any other routing reason (for example the router predicted Lightning). */
  lightning_router: number;
  ollama: number;
}

export interface RunShares {
  run: string;
  system: string | null;
  set: string;
  label: string;
  started_at: string;
  steps: Record<ReasoningStep, StepShare>;
}

/** Plain names of the system versions the documents talk about; any other version is named by its id. */
const SYSTEM_LABEL: Record<string, string> = {
  sys5: "the current system before the block fix",
  sys6: "the current system",
};
export const systemLabel = (system: string | null | undefined): string =>
  !system ? "the first system" : (SYSTEM_LABEL[system] ?? `system ${system}`);

interface ShareEvent extends TraceEvent {
  retry_count?: number | string;
  model_requested?: string;
  receipt?: { decision_id?: string };
}
interface RoutingReceipt {
  decision_id?: string;
  routing?: { predicted?: string; winner?: string; hedge?: unknown };
}
const emptyShare = (): StepShare => ({
  nightshift: 0,
  ultra: 0,
  lightning_retry: 0,
  lightning_hedged: 0,
  lightning_router: 0,
  ollama: 0,
});

/**
 * For the first system's 70-case routed run and every routed run of a later system version (`system` sysN), who answered
 * the decision, critic and challenger calls, read from the exported trace and the signed receipts in eval/runs.
 */
export function reasoningShares(root: string): RunShares[] {
  const files = tracked(root, "eval/runs");
  const out: RunShares[] = [];
  for (const rel of files.filter((f) => f.endsWith("/results.json"))) {
    const folder = rel.slice(0, -"/results.json".length);
    const r = readJson<{ variant: string; system?: string; exam?: string; started_at: string }>(root, rel);
    if (r.variant !== "routed") continue;
    const first = r.system === undefined && (r.exam ?? "exam") === "exam";
    if (!first && !/^sys\d/.test(r.system ?? "")) continue;
    if (!files.includes(`${folder}/trace.jsonl.gz`) || !files.includes(`${folder}/receipts.jsonl.gz`)) continue;
    const receipts = new Map<string, RoutingReceipt>();
    for (const env of jsonl(root, `${folder}/receipts.jsonl.gz`) as Array<{ body?: { receipt?: RoutingReceipt } }>) {
      const rc = env.body?.receipt;
      if (rc?.decision_id) receipts.set(rc.decision_id, rc);
    }
    const steps = { decision: emptyShare(), critic: emptyShare(), challenger: emptyShare() };
    for (const e of jsonl(root, `${folder}/trace.jsonl.gz`) as ShareEvent[]) {
      if (e.action !== "model_answer" || !(e.agent in REASONING_LANES)) continue;
      if (!e.provider || !e.model_used || e.provider === "fallback-rules") continue;
      const s = steps[e.agent as ReasoningStep];
      if (e.provider === "ollama") {
        s.ollama += 1;
        continue;
      }
      s.nightshift += 1;
      const m = modelOf(e.model_used, e.provider);
      if (m === ULTRA) s.ultra += 1;
      else if (num(e.retry_count) >= 1 && e.model_requested === "meterless/fast") s.lightning_retry += 1;
      else {
        const routing = receipts.get(e.receipt?.decision_id ?? "")?.routing;
        const hedged =
          routing?.hedge != null &&
          modelOf(routing.predicted ?? "") === ULTRA &&
          modelOf(routing.winner ?? "") === LIGHTNING;
        if (hedged) s.lightning_hedged += 1;
        else s.lightning_router += 1;
      }
    }
    out.push({
      run: folder.split("/").at(-1) as string,
      system: r.system ?? null,
      set: setName(r.exam === "exam" ? undefined : r.exam),
      label: systemLabel(r.system),
      started_at: r.started_at,
      steps,
    });
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** The first system's 70-case run and the newest 70-case run of a later system version (undefined until there is one). */
export function firstAndCurrent(runs: readonly RunShares[]): { first?: RunShares; current?: RunShares } {
  return {
    first: runs.find((r) => r.system === null),
    current: runs.filter((r) => r.system !== null && r.set === "exam").at(-1),
  };
}

const lightningOf = (s: StepShare) => s.lightning_retry + s.lightning_hedged + s.lightning_router;
const ofNightshift = (s: StepShare) => `${s.ultra} of ${s.nightshift}`;
const ofThe = (s: StepShare) => `${s.ultra} of the ${s.nightshift}`;
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The generated sentences the documents quote (README.md and docs/*.md, as facts). */
export function reasoningFacts(runs: readonly RunShares[]): Record<string, string> {
  const { first, current } = firstAndCurrent(runs);
  if (!first) throw new Error("eval/runs has no exported routed run of the first system");
  const sum = (r: RunShares, pick: (s: StepShare) => number) =>
    (Object.keys(REASONING_LANES) as ReasoningStep[]).reduce((t, k) => t + pick(r.steps[k]), 0);
  const all = (r: RunShares) => `${sum(r, (s) => s.ultra)} of ${sum(r, (s) => s.nightshift)}`;
  const inRun = (r: RunShares) => (r.system === null ? "the first system's run" : `the run of ${r.label}`);
  const lightningNote = (r: RunShares) => {
    const s = r.steps.decision;
    const were = (k: number) => (k === 1 ? "was" : "were");
    const parts = [
      s.lightning_retry > 0
        ? `${s.lightning_retry} ${were(s.lightning_retry)} the desk's fast-lane retry after an unusable or failed first answer. That retry is a deliberate fallback: it asks for \`meterless/fast\` under the guard identity, which the cockpit binds to the local lane.`
        : "",
      s.lightning_hedged > 0
        ? `${s.lightning_hedged} ${s.lightning_hedged === 1 ? "was a deep-lane call" : "were deep-lane calls"} where Nightshift's router predicted Ultra but Lightning won a hedged race.`
        : "",
      s.lightning_router > 0
        ? `${s.lightning_router} ${s.lightning_router === 1 ? "was a deep-lane call" : "were deep-lane calls"} the router gave to Lightning.`
        : "",
    ].filter(Boolean);
    const lightning = lightningOf(s);
    const head =
      lightning === 0
        ? `In ${inRun(r)}, Lightning answered no decision call.`
        : `Lightning answered ${plural(lightning, "decision call", "decision calls")} in ${inRun(r)}. ${parts.join(" ")}`;
    return `${head} ${plural(s.ollama, "more decision answer", "more decision answers")} came from the Ollama backup (no receipt).`;
  };
  const currentPart = current
    ? `, and ${ofNightshift(current.steps.decision)} in ${inRun(current)}`
    : "; the current system's re-run is in progress";
  return {
    decision_ultra_first: ofNightshift(first.steps.decision),
    decision_ultra_current: current ? ofNightshift(current.steps.decision) : "not run yet",
    current_run_label: current ? inRun(current) : "the current system's run (not run yet)",
    reasoning_ultra_first: all(first),
    reasoning_ultra_current: current ? all(current) : "not run yet",
    decision_models_line: `The decision step asks for the deep lane (\`meterless/deep\`). The mode is pinned; Nightshift's router chooses the serving model. Ultra answered ${ofThe(first.steps.decision)} decision calls Nightshift served in ${inRun(first)}${currentPart}.`,
    reasoning_models_line: `The critic asks for its own review lane (\`meterless/judge\`) and the challenger for the deep lane. Ultra answered ${ofNightshift(first.steps.critic)} critic calls and ${ofNightshift(first.steps.challenger)} challenger calls Nightshift served in ${inRun(first)}${current ? ` (${ofNightshift(current.steps.critic)} and ${ofNightshift(current.steps.challenger)} in ${inRun(current)})` : ""}.`,
    decision_lightning_note: lightningNote(current ?? first),
  };
}

// ---- calibration -----------------------------------------------------------------------------------------------

export interface ScoredCase {
  expected: string;
  acceptable?: string[];
  got: string;
  confidence?: number;
}

/**
 * The Brier score as docs/NEMOTRON.md defines it: the mean of (confidence - y) squared over the cases that have a
 * confidence and are not errors, where y is 1 when the chosen outcome is acceptable for the case (its expected or an
 * acceptable outcome) and 0 otherwise. Null when no case has a confidence.
 */
export function brier(cases: readonly ScoredCase[]): { n: number; brier: number | null } {
  const scored = cases.filter((c) => typeof c.confidence === "number" && c.got !== "ERROR");
  if (scored.length === 0) return { n: 0, brier: null };
  const y = (c: ScoredCase) => (c.got === c.expected || (c.acceptable ?? []).includes(c.got) ? 1 : 0);
  const sum = scored.reduce((t, c) => t + ((c.confidence as number) - y(c)) ** 2, 0);
  return { n: scored.length, brier: round3(sum / scored.length) };
}

export interface ResultFile {
  variant: string;
  exam?: string;
  system?: string;
  run?: string;
  features?: { with_free_text?: boolean };
  cases: ScoredCase[];
}

export interface CalibrationRow {
  arm: string;
  cases_with_confidence: number;
  brier: number | null;
  source: string;
}

const setName = (exam?: string) =>
  exam === undefined ? "exam" : exam === "heldout" ? "held-out v1" : exam.replace(/^heldout(\d)$/, "held-out v$1");
/** The arm a result file belongs to; a study run's `system` field is its run label, so it is left out there. */
const armName = (r: ResultFile, withSystem = true) =>
  r.variant === "nemotron_alone"
    ? `Nemotron alone, ${r.features?.with_free_text ? "with the free text" : "no free text"}`
    : r.variant === "routed"
      ? `Full system${withSystem && r.system ? ` (${r.system})` : ""}`
      : r.variant === "lightning"
        ? "Reasoning on Lightning"
        : r.variant;
/** Notes that a result file cannot carry, keyed by study folder. */
const STUDY_NOTE: Record<string, string> = { "heldout3-rerun": "not blind" };

/** One calibration row for an exam result file (eval/results), or null when its cases carry no confidence. */
export function resultRow(rel: string, r: ResultFile): CalibrationRow | null {
  if (!Array.isArray(r.cases)) return null;
  const b = brier(r.cases);
  if (b.n === 0) return null;
  return {
    arm: `${armName(r)} (${setName(r.exam)}, ${r.cases.length} cases, one run${r.run ? ` ${r.run}` : ""})`,
    cases_with_confidence: b.n,
    brier: b.brier,
    source: rel,
  };
}

/**
 * Every arm with confidences: the committed study runs (eval/studies, pooled per study and arm), the arms whose
 * confidences are only in the study summary eval/repeat-study.json (records kept on the machine that ran them), and
 * every result file in eval/results whose cases carry a confidence (one row per file, so a new exam result is
 * included as soon as it is committed).
 */
export function calibration(root: string): { rows: CalibrationRow[]; definition: string } {
  const rows: CalibrationRow[] = [];
  const groups = new Map<string, { study: string; files: Array<{ rel: string; r: ResultFile }> }>();
  for (const rel of tracked(root, "eval/studies").filter((f) => f.endsWith("/results.json"))) {
    const r = readJson<ResultFile>(root, rel);
    const study = rel.split("/")[2] as string;
    const key = `${study}\u0000${armName(r, false)}`;
    const g = groups.get(key) ?? { study, files: [] };
    g.files.push({ rel, r });
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    // A study arm where a run has no confidences at all (they stayed in records on the machine) is not pooled here.
    if (g.files.some((f) => brier(f.r.cases).n === 0)) continue;
    const exams = [...new Set(g.files.map((f) => setName(f.r.exam)))];
    const perSet = exams.map((e) => {
      const fs = g.files.filter((f) => setName(f.r.exam) === e);
      return `${e}, ${fs[0]?.r.cases.length} cases x ${fs.length} ${fs.length === 1 ? "run" : "runs"}`;
    });
    const note = STUDY_NOTE[g.study];
    const b = brier(g.files.flatMap((f) => f.r.cases));
    rows.push({
      arm: `${key.split("\u0000")[1]} (${perSet.join("; ")}${note ? `, ${note}` : ""})`,
      cases_with_confidence: b.n,
      brier: b.brier,
      source: `eval/studies/${g.study}`,
    });
  }
  const study = readJson<{
    calibration: Array<{ label: string; cases_with_confidence: number; brier: number | null }>;
    brier_definition: string;
  }>(root, "eval/repeat-study.json");
  // The three "runs above" arms are recomputed from the study runs; they must agree with the summary.
  for (const c of study.calibration) {
    if (/\(3 runs above\)/.test(c.label)) {
      const name = c.label.replace(" (3 runs above)", "");
      const mine = rows.find((r) => r.source === "eval/studies/repeat-heldout4" && r.arm.startsWith(`${name} (`));
      if (!mine || mine.brier !== c.brier || mine.cases_with_confidence !== c.cases_with_confidence)
        throw new Error(`Brier of "${c.label}" in eval/repeat-study.json does not match the study runs`);
    } else if (c.brier !== null) {
      rows.push({
        arm: c.label.replace(/\(\d{1,2} Oct, /, "("),
        cases_with_confidence: c.cases_with_confidence,
        brier: c.brier,
        source: "eval/repeat-study.json",
      });
    }
  }
  for (const rel of tracked(root, "eval/results").filter((f) => /\.json$/.test(f) && !/\/bench-/.test(f))) {
    const row = resultRow(rel, readJson<ResultFile>(root, rel));
    if (row) rows.push(row);
  }
  // The main study first (full system, then Nemotron alone without and with the text), then its summary, then the rest.
  const rank = (r: CalibrationRow) =>
    (r.source === "eval/studies/repeat-heldout4" ? 0 : r.source === "eval/repeat-study.json" ? 10 : 20) +
    (r.arm.startsWith("Full system") ? 0 : r.arm.includes("no free text") ? 1 : 2);
  return { rows: rows.sort((a, b) => rank(a) - rank(b)), definition: study.brier_definition };
}

/** Brier score of always answering with confidence 0.5. */
export const CONSTANT_GUESS_BRIER = 0.25;

/**
 * The plain note on the main study's arms (held-out v4, three runs each): which score worse than a constant 0.5 guess
 * and which better. Empty when the study has no rows.
 */
export function brierNote(rows: readonly CalibrationRow[]): string {
  const study = rows.filter((r) => r.source === "eval/studies/repeat-heldout4" && r.brier !== null);
  if (study.length === 0) return "";
  const name = (r: CalibrationRow) => r.arm.replace(/ \(held-out v4.*$/, "");
  const cell = (r: CalibrationRow) => `${name(r)}: ${r.brier}`;
  const worse = study.filter((r) => (r.brier as number) > CONSTANT_GUESS_BRIER);
  const better = study.filter((r) => (r.brier as number) <= CONSTANT_GUESS_BRIER);
  const guess = `always answering with confidence 0.5, which scores ${CONSTANT_GUESS_BRIER}`;
  if (better.length === 0)
    return `On held-out v4 (three runs each), every arm scores worse than ${guess} (${study.map(cell).join("; ")}), so on that set the stated confidences are less useful than a flat 0.5.`;
  if (worse.length === 0)
    return `On held-out v4 (three runs each), every arm scores at or better than ${guess} (${study.map(cell).join("; ")}).`;
  return `On held-out v4 (three runs each), worse than ${guess}: ${worse.map(cell).join("; ")}; at or better than it: ${better.map(cell).join("; ")}.`;
}

// ---- safety guard ----------------------------------------------------------------------------------------------

interface GuardRow {
  family: string;
  place: string;
  caught?: boolean;
}

export interface GuardResult {
  test: string;
  x: number;
  n: number;
  low: number;
  high: number;
  source: string;
}

const latest = (files: string[], re: RegExp) => files.filter((f) => re.test(f.split("/").at(-1) as string)).at(-1);

/** The full-review results of the safety guard, as docs/EVALUATION.md reports them, from eval/adversarial. */
export function guardResults(root: string): GuardResult[] {
  const files = tracked(root, "eval/adversarial");
  const reviewRel = latest(files, /^review-.*\.json$/);
  const freshRel = latest(files, /^fresh-\d{4}-.*\.json$/);
  if (!reviewRel || !freshRel) throw new Error("eval/adversarial has no committed review-*.json or fresh-*.json");
  const review = readJson<{ rows: GuardRow[] }>(root, reviewRel).rows;
  const fresh = readJson<{ rows: GuardRow[] }>(root, freshRel).rows;
  const caught = (rows: GuardRow[]) => rows.filter((r) => r.caught === true).length;
  const row = (test: string, rows: GuardRow[], source: string): GuardResult => {
    const x = caught(rows);
    return { test, x, n: rows.length, ...wilson95(x, rows.length), source };
  };
  const inbound = (rows: GuardRow[], family: string) => rows.filter((r) => r.family === family && r.place !== "draft");
  return [
    row("Injected text caught, 105-text full-review run (guard asked once)", inbound(review, "injection"), reviewRel),
    row("Injected text caught, fresh-set run (current guard)", inbound(fresh, "injection"), freshRel),
    row("False alarms on harmless text, fresh-set run (current guard)", inbound(fresh, "benign"), freshRel),
    row(
      "False alarms on harmless text, 105-text full-review run (guard asked once)",
      inbound(review, "benign"),
      reviewRel,
    ),
  ];
}

// ---- the 70 cases, per arm -----------------------------------------------------------------------------------------

/** One arm of the 70-case comparison; the figures are null until the arm's result file is committed. */
export interface ExamArmRow {
  arm: string;
  source: string | null;
  figures: {
    wrong: number;
    risk: number;
    wrong_range: string;
    clears_made: number;
    clears: number;
    blocks: number;
    unsupported_blocks: number;
    not_block_cases: number;
    unsupported_range: string;
    unusable: number;
    answer_from: string;
  } | null;
}

/**
 * The 70-case arms (the same computation as the five-ways table of eval/REPORT.md, tools/lib/exam-figures.ts) from the
 * tracked result files, scored against the committed exam labels, with the tracked run exports for the answer sources;
 * and the blind held-out totals with the rules-versus-full-system framing.
 */
export function examComparison(root: string): { arms: ExamArmRow[]; heldout: HeldoutTotals; framing: string } {
  const results = tracked(root, "eval/results").filter((f) => /\.json$/.test(f) && !/\/bench-/.test(f));
  const runs = results.map((rel) => ({ ...readJson<ExamRun>(root, rel), file: rel }));
  const labels = new Map<string, LabelSet>(
    readJson<{ cases: Array<LabelSet & { case_id: string }> }>(root, "eval/cases/exam.json").cases.map((c) => [
      c.case_id,
      c,
    ]),
  );
  const runFiles = tracked(root, "eval/runs");
  const runDirs = runFiles
    .filter((f) => f.endsWith("/run-meta.json"))
    .map((f) => f.slice(0, -"/run-meta.json".length))
    .filter((d) => runFiles.includes(`${d}/trace.jsonl.gz`))
    .map((d) => join(root, d));
  const a = examArms(runs, labels);
  const arms = armRows(a).map(({ label, run }): ExamArmRow => {
    if (!run) return { arm: label, source: null, figures: null };
    const f = examFigures(run);
    return {
      arm: label,
      source: run.file,
      figures: {
        wrong: f.wrong,
        risk: f.risk,
        wrong_range: range95(f.wrong, f.risk),
        clears_made: f.made,
        clears: f.clears,
        blocks: f.blocks,
        unsupported_blocks: f.unsupportedBlocks,
        not_block_cases: f.notBlockCases,
        unsupported_range: range95(f.unsupportedBlocks, f.notBlockCases),
        unusable: f.unusable,
        answer_from: answerSources(run, runDirs),
      },
    };
  });
  const heldout = heldoutTotals(
    heldoutRounds(
      results.map((rel) => ({ ...readJson<SavedResult>(root, rel), file: rel.split("/").at(-1) as string })),
    ),
  );
  return { arms, heldout, framing: rulesFraming(a.rules ? examFigures(a.rules) : undefined, heldout) };
}

// ---- the scorecard ---------------------------------------------------------------------------------------------

export interface Scorecard {
  note: string;
  steps: readonly StepRow[];
  recorded_runs: number;
  models: ModelRow[];
  local_share: ModelStats["local_share"];
  calibration: CalibrationRow[];
  brier_definition: string;
  guard: GuardResult[];
  /** Who answered the decision, critic and challenger calls in the first system's run and every later system's run. */
  reasoning_models: RunShares[];
  /** The sentences README.md and docs/*.md quote from reasoning_models (npm run readme:refresh). */
  reasoning_facts: Record<string, string>;
  /** The 70 cases per arm: risk cases wrongly closed, clears, blocks, unsupported blocks, unusable answers. */
  exam_arms: ExamArmRow[];
  /** Totals over the blind held-out rounds, and the same without v2. */
  heldout_totals: HeldoutSummary;
  /** Why the rules look exact on the 70 cases, against what they did on the held-out rounds. */
  rules_framing: string;
  /** The one receipt figure (tools/lib/receipt-figure.ts), as the README and the site quote it. */
  receipt_figure: string;
  /** Whether the arms of the held-out v4 study score worse than a constant 0.5 guess (Brier 0.25), in words. */
  brier_note: string;
  not_used: string;
}

export const NOT_USED_LINK = "docs/NEMOTRON.md#what-we-tried-and-why-it-isnt-used";

interface ReceiptStatsGroup {
  id: string;
  runs: number;
  rows: Array<{ model: string; calls: number }>;
}

/**
 * Throws unless each group of exported runs in eval/receipt-stats.json (recorded, current system, Nemotron alone) has
 * the same number of runs and, per model, the same calls as the traces of that group in eval/runs, and no group is
 * missing from either side; otherwise eval/receipt-stats.json is out of date.
 */
export function checkAgainstReceiptStats(root: string, groups: readonly ReceiptStatsGroup[]): void {
  for (const id of RUN_GROUP_ORDER) {
    const ours = modelStats(root, id);
    const theirs = groups.find((g) => g.id === id);
    if (ours.runs === 0 && !theirs) continue;
    if (!theirs || theirs.runs !== ours.runs)
      throw new Error(
        `${id}: ${ours.runs} runs in eval/runs, ${theirs?.runs ?? 0} in eval/receipt-stats.json; run npm run receipt:stats`,
      );
    const models = new Set([
      ...ours.models.map((m) => m.model),
      ...theirs.rows.map((r) => r.model.replace(/ \((local|cloud)\)$/, "")),
    ]);
    for (const model of models) {
      const mine = ours.models.find((m) => m.model === model)?.calls ?? 0;
      const listed = theirs.rows
        .filter((r) => r.model.replace(/ \((local|cloud)\)$/, "") === model)
        .reduce((t, r) => t + r.calls, 0);
      if (mine !== listed)
        throw new Error(
          `${id}, ${model}: ${mine} calls in eval/runs, ${listed} in eval/receipt-stats.json; run npm run receipt:stats`,
        );
    }
  }
}

export function buildScorecard(root: string): Scorecard {
  const stats = modelStats(root);
  checkAgainstReceiptStats(root, readJson<{ groups: ReceiptStatsGroup[] }>(root, "eval/receipt-stats.json").groups);
  const cal = calibration(root);
  const shares = reasoningShares(root);
  const exam = examComparison(root);
  return {
    note: "Written by npm run nemotron:scorecard from committed files; do not edit by hand.",
    steps: STEPS,
    recorded_runs: stats.runs,
    models: stats.models,
    local_share: stats.local_share,
    calibration: cal.rows,
    brier_definition: cal.definition,
    guard: guardResults(root),
    reasoning_models: shares,
    reasoning_facts: reasoningFacts(shares),
    exam_arms: exam.arms,
    heldout_totals: heldoutSummary(exam.heldout),
    rules_framing: exam.framing,
    receipt_figure: receiptSentence(receiptFigure(root)),
    brier_note: brierNote(cal.rows),
    not_used: NOT_USED_LINK,
  };
}

const n = (x: number) => x.toLocaleString("en-US");
/** A short link label for a source file, without the run time in its name. */
const sourceLabel = (src: string) => {
  const base = src.split("/").at(-1) as string;
  if (/^review-/.test(base)) return "full-review run";
  if (/^fresh-/.test(base)) return "fresh-set run";
  if (src.startsWith("eval/results/")) return "result file";
  return base;
};
const sourceLink = (src: string) =>
  `[${sourceLabel(src)}](../${src.startsWith("eval/studies/") ? "eval/studies/README.md" : src})`;
const costCell = (m: ModelRow) =>
  m.cost === null
    ? "not recorded (no receipt)"
    : `USD ${m.cost.actual_usd_total} on all ${n(m.cost.receipts)} receipts (\`cost.actual_usd\`)`;

/** The arms the scorecard table shows: the newest full-system run that exists, then every other arm. */
export function shownArms(arms: readonly ExamArmRow[]): ExamArmRow[] {
  const full = arms.filter((a) => a.arm.startsWith("Full system"));
  const newest = full.filter((a) => a.figures !== null).at(-1) ?? full[0];
  return arms.filter((a) => !a.arm.startsWith("Full system") || a === newest);
}

/** The Markdown block written between the nemotron-scorecard markers of docs/NEMOTRON.md. */
export function renderScorecard(s: Scorecard): string {
  const pct = Math.round(s.local_share.share * 100);
  return [
    `**Nemotron scorecard.** Computed by \`npm run nemotron:scorecard\` from committed files only ([eval/nemotron-scorecard.json](../eval/nemotron-scorecard.json)); each part is detailed further down this page.`,
    "",
    "| Step | Model | Where | Why |",
    "| --- | --- | --- | --- |",
    ...s.steps.map(
      (r) => `| ${r.step} | ${r.model === ULTRA ? `${ULTRA} ${ROUTER_NOTE}` : r.model} | ${r.where} | ${r.why}. |`,
    ),
    "",
    `${s.reasoning_facts.decision_models_line ?? ""} ${s.reasoning_facts.decision_lightning_note ?? ""}`,
    "",
    "**The 70 cases, per arm** (one run each; 95% Wilson ranges in brackets; an unsupported block is a block recommendation on a case whose labels do not accept a block, counted over those cases; the last column counts, per case, the model whose decision answer was used, from the run's exported trace):",
    "",
    "| Arm | Risk cases wrongly closed | Clears made | Blocks | Unsupported blocks | Unusable answers | Decision answer used came from |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...shownArms(s.exam_arms).map((a) => {
      const f = a.figures;
      if (!f || !a.source) return `| ${a.arm} | not run yet | | | | | |`;
      return `| ${a.arm} ([result](../${a.source})) | ${f.wrong} of ${f.risk} (${f.wrong_range}) | ${f.clears_made} of ${f.clears} | ${f.blocks} | ${f.unsupported_blocks} of ${f.not_block_cases} (${f.unsupported_range}) | ${f.unusable} | ${f.answer_from} |`;
    }),
    "",
    `The full system's row is its newest run on the 70 cases. Its earlier runs, and the fix for block recommendations on true matches made between them: [EVALUATION.md](EVALUATION.md#a-block-recommendation-regression-found-in-the-current-system-comparison).`,
    "",
    ...heldoutTotalsTable(s.heldout_totals),
    "",
    s.rules_framing,
    "",
    `**Per model, recorded evaluation runs** (${s.recorded_runs} exported runs in eval/runs; safety guard, screener, decision, critic and challenger calls; the current-system runs and the Nemotron-alone study arm are counted apart under [Receipt statistics](#receipt-statistics)):`,
    "",
    "| Model | Where | Calls | Median s | Median tokens in | Median tokens out | Cost recorded in the receipts |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...s.models.map(
      (m) =>
        `| ${m.model} | ${m.where} | ${n(m.calls)} | ${m.median_latency_s} | ${n(m.median_tokens_in)} | ${n(m.median_tokens_out)} | ${costCell(m)} |`,
    ),
    "",
    `Answered on the laptop: ${n(s.local_share.local_calls)} of ${n(s.local_share.all_calls)} model calls (${pct}%), Lightning through Nightshift and the Ollama backup together. The per-case \`cost\` in the result files is worked out from the illustrative unit costs in \`config/default.json\`, not recorded, so it is not shown.`,
    "",
    `**Receipts.** ${s.receipt_figure}.`,
    "",
    "**Safety guard** (95% Wilson ranges in brackets):",
    "",
    "| Test | Result | Source |",
    "| --- | ---: | --- |",
    ...s.guard.map((g) => `| ${g.test} | ${countWithInterval(g.x, g.n)} | ${sourceLink(g.source)} |`),
    "",
    "**Calibration** (Brier score, lower is better; indicative only with this few cases):",
    "",
    "| Arm | Cases with a confidence (n) | Brier score | Source |",
    "| --- | ---: | ---: | --- |",
    ...s.calibration.map(
      (c) =>
        `| ${c.arm} | ${c.cases_with_confidence} | ${c.brier === null ? "n/a" : c.brier} | ${sourceLink(c.source)} |`,
    ),
    "",
    `Brier score: ${s.brier_definition}${s.brier_note ? ` ${s.brier_note}` : ""}`,
    "",
    `What we tried and did not use (guard and jailbreak-detection models, embedding, document images): [What we tried and why it isn't used](#what-we-tried-and-why-it-isnt-used).`,
  ].join("\n");
}

export const BLOCK_RE = /(<!-- nemotron-scorecard:start -->)[\s\S]*?(<!-- nemotron-scorecard:end -->)/;

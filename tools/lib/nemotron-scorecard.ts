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
import { countWithInterval, median, wilson95 } from "@sanctions-desk/shared";

// ---- the steps (the why text is the start of the "Why this model" cell in docs/NEMOTRON.md; checked on build) ----

export const LIGHTNING = "Nemotron 3.5 Lightning 30B";
export const ULTRA = "Nemotron 3 Ultra 550B";
export const OLLAMA = "Ollama backup (Lightning, no receipt)";
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

/** Per model, over the exported recorded runs in eval/runs: the trace events and the receipts of each run. */
export function modelStats(root: string): ModelStats {
  const files = tracked(root, "eval/runs");
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
    row("Injected text caught, full reviews, guard asked once", inbound(review, "injection"), reviewRel),
    row("Injected text caught, fresh set, current guard", inbound(fresh, "injection"), freshRel),
    row("False alarms on harmless text, fresh set, current guard", inbound(fresh, "benign"), freshRel),
    row("False alarms on harmless text, full reviews, guard asked once", inbound(review, "benign"), reviewRel),
  ];
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
  not_used: string;
}

export const NOT_USED_LINK = "docs/NEMOTRON.md#what-we-tried-and-why-it-isnt-used";

export function buildScorecard(root: string): Scorecard {
  const stats = modelStats(root);
  // The same calls as the recorded group of eval/receipt-stats.json, or that file is out of date.
  const rs = readJson<{ groups: Array<{ id: string; rows: Array<{ model: string; calls: number }> }> }>(
    root,
    "eval/receipt-stats.json",
  ).groups.find((g) => g.id === "recorded");
  for (const m of stats.models) {
    const theirs = (rs?.rows ?? [])
      .filter((r) => r.model.replace(/ \((local|cloud)\)$/, "") === m.model)
      .reduce((t, r) => t + r.calls, 0);
    if (theirs !== m.calls)
      throw new Error(
        `${m.model}: ${m.calls} calls in eval/runs, ${theirs} in eval/receipt-stats.json; run npm run receipt:stats`,
      );
  }
  const cal = calibration(root);
  return {
    note: "Written by npm run nemotron:scorecard from committed files; do not edit by hand.",
    steps: STEPS,
    recorded_runs: stats.runs,
    models: stats.models,
    local_share: stats.local_share,
    calibration: cal.rows,
    brier_definition: cal.definition,
    guard: guardResults(root),
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

/** The Markdown block written between the nemotron-scorecard markers of docs/NEMOTRON.md. */
export function renderScorecard(s: Scorecard): string {
  const pct = Math.round(s.local_share.share * 100);
  return [
    `**Nemotron scorecard.** Computed by \`npm run nemotron:scorecard\` from committed files only ([eval/nemotron-scorecard.json](../eval/nemotron-scorecard.json)); each part is detailed further down this page.`,
    "",
    "| Step | Model | Where | Why |",
    "| --- | --- | --- | --- |",
    ...s.steps.map((r) => `| ${r.step} | ${r.model} | ${r.where} | ${r.why}. |`),
    "",
    `**Per model, recorded runs** (${s.recorded_runs} exported runs in eval/runs; safety guard, screener, decision, critic and challenger calls):`,
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
    "**Calibration** (Brier score, lower is better; indicative only with this few cases):",
    "",
    "| Arm | Cases with a confidence (n) | Brier score | Source |",
    "| --- | ---: | ---: | --- |",
    ...s.calibration.map(
      (c) =>
        `| ${c.arm} | ${c.cases_with_confidence} | ${c.brier === null ? "n/a" : c.brier} | ${sourceLink(c.source)} |`,
    ),
    "",
    `Brier score: ${s.brier_definition}`,
    "",
    "**Safety guard** (95% Wilson ranges in brackets):",
    "",
    "| Test | Result | Source |",
    "| --- | ---: | --- |",
    ...s.guard.map((g) => `| ${g.test} | ${countWithInterval(g.x, g.n)} | ${sourceLink(g.source)} |`),
    "",
    `What we tried and did not use (guard and jailbreak-detection models, embedding, document images): [What we tried and why it isn't used](#what-we-tried-and-why-it-isnt-used).`,
  ].join("\n");
}

export const BLOCK_RE = /(<!-- nemotron-scorecard:start -->)[\s\S]*?(<!-- nemotron-scorecard:end -->)/;

/**
 * The fully local mode study: held-out v4 run three times with every model step on Nemotron 3.5 Lightning on the
 * laptop (the exam's `lightning` variant: decision, critic and challenger sent under the guard identity, which the
 * cockpit binds to the local lane) and three times in the default mode (`routed`). Per run and per arm: risk cases
 * wrongly closed, clears made, unsupported blocks, unusable answers, time per case, model calls by the model that
 * served them, and cost (what the receipts record, and the illustrative figure worked out from the unit costs in
 * config/default.json).
 *
 * Pure functions only; tools/local-mode-study.ts reads the exported study runs (eval/studies/local-mode) and writes.
 */
import type { Metrics, ScoredCase } from "@sanctions-desk/agents";
import { median, percentile } from "@sanctions-desk/shared";
import { examFigures, range95 } from "./exam-figures.js";

export const LIGHTNING = "Nemotron 3.5 Lightning 30B";
export const ULTRA = "Nemotron 3 Ultra 550B";
export const OLLAMA = "Ollama backup (Lightning, no receipt)";
/** The five steps that call a model (the same set as npm run receipt:stats). */
const MODEL_STEPS = new Set(["policy_guard", "screener", "decision", "critic", "challenger"]);

export type ArmId = "local" | "default";
export const ARMS: ReadonlyArray<{ id: ArmId; variant: string; tag: RegExp; label: string }> = [
  {
    id: "local",
    variant: "lightning",
    tag: /^a3-local-r\d+$/,
    label: "Fully local mode: every step on Nemotron 3.5 Lightning (laptop)",
  },
  {
    id: "default",
    variant: "routed",
    tag: /^a3-default-r\d+$/,
    label: "Default mode: decision, critic and challenger on the cloud lane",
  },
];
export const RUNS_PER_ARM = 3;

/** The arm of a result file from its variant and tag, or undefined when it is not a run of this study. */
export function armOf(r: { variant: string; tag?: string | null }): ArmId | undefined {
  return ARMS.find((a) => a.variant === r.variant && a.tag.test(r.tag ?? ""))?.id;
}

/** The plain name of the model that served a call, from the trace's `model_used` and `provider`. */
export function servedModel(modelUsed: string, provider?: string | null): string {
  if (provider === "ollama") return OLLAMA;
  if (/ultra/i.test(modelUsed)) return ULTRA;
  if (/lightning/i.test(modelUsed)) return LIGHTNING;
  return modelUsed;
}

export interface TraceEvent {
  agent: string;
  action: string;
  provider?: string | null;
  model_used?: string | null;
  receipt?: { receipt_id?: string } | null;
}
export interface Receipt {
  body?: { receipt?: { receipt_id?: string; cost?: { actual_usd?: number } } };
}
export interface StudyResult {
  variant: string;
  tag?: string | null;
  cases: ScoredCase[];
  metrics: Metrics;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Model calls per served model, from the model answers of the five model steps (failed calls carry no model). */
export function callsByModel(events: readonly TraceEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.action !== "model_answer" || !MODEL_STEPS.has(e.agent)) continue;
    if (!e.provider || !e.model_used || e.provider === "fallback-rules") continue;
    const m = servedModel(e.model_used, e.provider);
    out[m] = (out[m] ?? 0) + 1;
  }
  return sortCalls(out);
}

/** Calls by model in a fixed order: Lightning, Ultra, the Ollama backup, then any other model by name. */
function sortCalls(calls: Record<string, number>): Record<string, number> {
  const order = [LIGHTNING, ULTRA, OLLAMA];
  const rank = (m: string) => (order.includes(m) ? order.indexOf(m) : order.length);
  return Object.fromEntries(Object.entries(calls).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)));
}

/** What the receipts record as cost: their number and the sum of `cost.actual_usd`. */
export function recordedCost(receipts: readonly Receipt[]): { receipts: number; actual_usd: number } {
  const usd = receipts.reduce((t, r) => {
    const v = r.body?.receipt?.cost?.actual_usd;
    return t + (typeof v === "number" ? v : 0);
  }, 0);
  return { receipts: receipts.length, actual_usd: round6(usd) };
}

export interface UnitCosts {
  currency: string;
  cloudInputPerMillionTokens: number;
  cloudOutputPerMillionTokens: number;
  localPerMillionTokens: number;
}

/** The labelled cost line: what the receipts record, and the illustrative figure, never presented as a price. */
export function costLabel(
  recorded: { receipts: number; actual_usd: number },
  illustrativeUsd: number,
  units: UnitCosts,
): string {
  return `${units.currency} ${recorded.actual_usd} recorded on ${recorded.receipts} receipts (\`cost.actual_usd\`); ${units.currency} ${round6(illustrativeUsd)} illustrative, worked out from the unit costs in \`config/default.json\` (cloud ${units.cloudInputPerMillionTokens} in and ${units.cloudOutputPerMillionTokens} out per million tokens, local ${units.localPerMillionTokens}), not a price`;
}

export interface RunFigures {
  run_id: string;
  arm: ArmId;
  tag: string;
  cases: number;
  wrong_closes: number;
  risk_cases: number;
  clears_made: number;
  clear_cases: number;
  unsupported_blocks: number;
  not_block_cases: number;
  unusable: number;
  /** Cases with a time (a case that timed out has none). */
  timed_cases: number;
  median_case_s: number;
  p95_case_s: number;
  case_seconds: number[];
  calls_by_model: Record<string, number>;
  recorded_cost: { receipts: number; actual_usd: number };
  /** The run's own cost figure (metrics.cost.total), worked out from the illustrative unit costs. */
  illustrative_usd: number;
}

/** The figures of one run from its result file, its trace events and its receipts. */
export function runFigures(
  runId: string,
  r: StudyResult,
  events: readonly TraceEvent[],
  receipts: readonly Receipt[],
): RunFigures {
  const arm = armOf(r);
  if (!arm) throw new Error(`${runId}: not a run of the local-mode study (variant ${r.variant}, tag ${r.tag})`);
  const f = examFigures(r);
  const secs = r.cases.flatMap((c) => (typeof c.latency_s === "number" ? [c.latency_s] : []));
  return {
    run_id: runId,
    arm,
    tag: r.tag ?? "",
    cases: f.cases,
    wrong_closes: f.wrong,
    risk_cases: f.risk,
    clears_made: f.made,
    clear_cases: f.clears,
    unsupported_blocks: f.unsupportedBlocks,
    not_block_cases: f.notBlockCases,
    unusable: f.unusable,
    timed_cases: secs.length,
    median_case_s: round1(median(secs)),
    p95_case_s: round1(percentile(secs, 95)),
    case_seconds: secs,
    calls_by_model: callsByModel(events),
    recorded_cost: recordedCost(receipts),
    illustrative_usd: round6(r.metrics.cost.total),
  };
}

export interface Pooled {
  runs: number;
  cases: number;
  wrong_closes: number;
  risk_cases: number;
  wrong_range: string;
  clears_made: number;
  clear_cases: number;
  clears_range: string;
  unsupported_blocks: number;
  not_block_cases: number;
  unsupported_range: string;
  unusable: number;
  unusable_range: string;
  timed_cases: number;
  median_case_s: number;
  p95_case_s: number;
  calls_by_model: Record<string, number>;
  recorded_cost: { receipts: number; actual_usd: number };
  illustrative_usd: number;
}

/** One arm's runs pooled: counts added over the runs, 95% Wilson ranges over the pooled counts, times over all cases. */
export function poolRuns(runs: readonly RunFigures[]): Pooled {
  const sum = (k: keyof RunFigures) => runs.reduce((t, r) => t + (r[k] as number), 0);
  const secs = runs.flatMap((r) => r.case_seconds);
  const calls: Record<string, number> = {};
  for (const r of runs) for (const [m, n] of Object.entries(r.calls_by_model)) calls[m] = (calls[m] ?? 0) + n;
  const wrong = sum("wrong_closes");
  const risk = sum("risk_cases");
  const made = sum("clears_made");
  const clears = sum("clear_cases");
  const unsupported = sum("unsupported_blocks");
  const notBlock = sum("not_block_cases");
  const unusable = sum("unusable");
  const cases = sum("cases");
  return {
    runs: runs.length,
    cases,
    wrong_closes: wrong,
    risk_cases: risk,
    wrong_range: range95(wrong, risk),
    clears_made: made,
    clear_cases: clears,
    clears_range: range95(made, clears),
    unsupported_blocks: unsupported,
    not_block_cases: notBlock,
    unsupported_range: range95(unsupported, notBlock),
    unusable,
    unusable_range: range95(unusable, cases),
    timed_cases: secs.length,
    median_case_s: round1(median(secs)),
    p95_case_s: round1(percentile(secs, 95)),
    calls_by_model: sortCalls(calls),
    recorded_cost: {
      receipts: runs.reduce((t, r) => t + r.recorded_cost.receipts, 0),
      actual_usd: round6(runs.reduce((t, r) => t + r.recorded_cost.actual_usd, 0)),
    },
    illustrative_usd: round6(runs.reduce((t, r) => t + r.illustrative_usd, 0)),
  };
}

export interface LocalModeStudy {
  note: string;
  label: string;
  status: "in_progress" | "complete";
  runs_found: number;
  runs_expected: number;
  unit_costs: UnitCosts;
  arms: Array<{ id: ArmId; label: string; runs: Array<Omit<RunFigures, "case_seconds">>; pooled: Pooled | null }>;
}

/** The study from the runs found so far; complete only with three runs in each arm. */
export function buildStudy(runs: readonly RunFigures[], units: UnitCosts): LocalModeStudy {
  const complete = ARMS.every((a) => runs.filter((r) => r.arm === a.id).length >= RUNS_PER_ARM);
  return {
    note: "Written by npm run study:local-mode from the exported study runs in eval/studies/local-mode; do not edit by hand.",
    label: "Small study of the fully local mode, held-out v4, three runs per arm, not part of the recorded evaluation",
    status: complete ? "complete" : "in_progress",
    runs_found: runs.length,
    runs_expected: ARMS.length * RUNS_PER_ARM,
    unit_costs: units,
    arms: ARMS.map((a) => {
      const mine = runs.filter((r) => r.arm === a.id);
      return {
        id: a.id,
        label: a.label,
        runs: mine.map(({ case_seconds: _s, ...rest }) => rest),
        pooled: complete ? poolRuns(mine) : null,
      };
    }),
  };
}

/** Model calls answered in the cloud (Ultra) out of all model calls, for one set of calls by model. */
export function cloudShare(calls: Record<string, number>): { cloud: number; all: number } {
  const all = Object.values(calls).reduce((t, n) => t + n, 0);
  return { cloud: calls[ULTRA] ?? 0, all };
}

const callsText = (calls: Record<string, number>) =>
  Object.entries(calls)
    .map(([m, n]) => `${m} ${n}`)
    .join(", ") || "none";

/** The earlier measurement of Lightning doing the reasoning (eval/model-choice.json), quoted until this study is in. */
export interface ModelChoiceArm {
  short: string;
  median_case_s: number;
  risk_cases: number;
  wrong_closes: number;
  clear_cases: number;
  clears_made: number;
}

const minutes = (s: number) => Math.max(1, Math.round(s / 60));

/** The block between the local-mode markers in docs/NEMOTRON.md. */
export function renderDocBlock(
  s: LocalModeStudy,
  choice: { ultra?: ModelChoiceArm; lightning?: ModelChoiceArm },
): string {
  const lead =
    "Every model step (safety guard, screener, decision, critic and challenger) on Nemotron 3.5 Lightning on the laptop: the decision, critic and challenger are sent under the guard identity, which the cockpit binds to the local lane, and the Ollama backup is the same model on the same machine, so all data and models stay on the machine. How to run it: [MODELS.md](MODELS.md#fully-local-mode).";
  if (s.status !== "complete") {
    const earlier =
      choice.ultra && choice.lightning
        ? ` Until then, the only measurement of Lightning doing the reasoning is the model-choice study above: a median of ${choice.lightning.median_case_s} s per case against ${choice.ultra.median_case_s} s, ${choice.lightning.clears_made} of ${choice.lightning.clear_cases} clears made against ${choice.ultra.clears_made} of ${choice.ultra.clear_cases}, ${choice.lightning.wrong_closes} of ${choice.lightning.risk_cases} risk cases wrongly closed in both arms${choice.ultra.wrong_closes === choice.lightning.wrong_closes ? "" : ` (default: ${choice.ultra.wrong_closes} of ${choice.ultra.risk_cases})`}.`
        : "";
    return `**${s.label}: in progress.** ${lead} Held-out v4 (12 cases) is being run three times in this mode and three times in the default mode; this block is written from their result files, traces and receipts by \`npm run study:local-mode\` once all ${s.runs_expected} runs are exported (${s.runs_found} of ${s.runs_expected} so far).${earlier}`;
  }
  const rows = s.arms.flatMap((a) => (a.pooled ? [{ a, p: a.pooled }] : []));
  const local = s.arms.find((a) => a.id === "local")?.pooled;
  const cloudLocal = local ? cloudShare(local.calls_by_model) : { cloud: 0, all: 0 };
  return [
    `**${s.label}.** ${lead} Each arm is held-out v4 (12 cases: 6 risk cases, 6 clears) run three times, Nightshift warmed up and not restarted; the counts are pooled over the three runs, with 95% Wilson ranges in brackets. An unsupported block is a block recommendation on a case whose labels do not accept a block. Result file: [eval/local-mode.json](../eval/local-mode.json); runs, traces and receipts: [eval/studies](../eval/studies/README.md).`,
    "",
    "| Arm | Risk cases wrongly closed | Clears made | Unsupported blocks | Unusable answers | Median s per case | p95 s per case | Model calls, by the model that served them |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      ({ a, p }) =>
        `| ${a.label} | ${p.wrong_closes} of ${p.risk_cases} (${p.wrong_range}) | ${p.clears_made} of ${p.clear_cases} (${p.clears_range}) | ${p.unsupported_blocks} of ${p.not_block_cases} (${p.unsupported_range}) | ${p.unusable} of ${p.cases} (${p.unusable_range}) | ${p.median_case_s} | ${p.p95_case_s} | ${callsText(p.calls_by_model)} |`,
    ),
    "",
    "Each run:",
    "",
    "| Arm | Run | Risk cases wrongly closed | Clears made | Unsupported blocks | Unusable answers | Median s per case |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...s.arms.flatMap((a) =>
      a.runs.map(
        (r) =>
          `| ${a.label} | ${r.tag} | ${r.wrong_closes} of ${r.risk_cases} | ${r.clears_made} of ${r.clear_cases} | ${r.unsupported_blocks} of ${r.not_block_cases} | ${r.unusable} | ${r.median_case_s} |`,
      ),
    ),
    "",
    `Model calls answered in the cloud in the fully local arm: ${cloudLocal.cloud} of ${cloudLocal.all}, from the trace and the signed receipts. A case that timed out has no time and is left out of the times (${rows.map(({ a, p }) => `${a.id}: ${p.cases - p.timed_cases}`).join(", ")}).`,
    "",
    `Cost, per arm over its three runs: ${rows.map(({ a, p }) => `${a.label}: ${costLabel(p.recorded_cost, p.illustrative_usd, s.unit_costs)}`).join("; ")}.`,
  ].join("\n");
}

/** The README line: the option, its trade-off and the time per alert; measured once the study is complete. */
export function renderReadmeLine(
  s: LocalModeStudy,
  choice: { ultra?: ModelChoiceArm; lightning?: ModelChoiceArm },
): string {
  const head =
    "**Fully local mode** (every step on Nemotron 3.5 Lightning on the laptop; all data and models stay on the machine): an option, with its trade-off";
  const how = "How to run it: [docs/MODELS.md](docs/MODELS.md#fully-local-mode).";
  const local = s.arms.find((a) => a.id === "local")?.pooled;
  const def = s.arms.find((a) => a.id === "default")?.pooled;
  if (s.status === "complete" && local && def) {
    const c = cloudShare(local.calls_by_model);
    return `- ${head}. On held-out v4, three runs per mode: ${local.wrong_closes} of ${local.risk_cases} risk cases wrongly closed against ${def.wrong_closes} of ${def.risk_cases} in the default mode, ${local.clears_made} of ${local.clear_cases} clears made against ${def.clears_made} of ${def.clear_cases}, ${local.unusable} of ${local.cases} cases without a usable answer against ${def.unusable} of ${def.cases}, a median of ${local.median_case_s} s per case against ${def.median_case_s} s; ${c.cloud} of ${c.all} model calls answered in the cloud ([details](docs/NEMOTRON.md#fully-local-mode-every-step-on-the-laptop)). 70-case local run: not measured (about ${minutes(local.median_case_s)} minutes per alert locally, the median per case of the local-mode runs). ${how}`;
  }
  const L = choice.lightning;
  const U = choice.ultra;
  const tradeOff =
    L && U
      ? `: in the model-choice study (20 cases, one run per arm) Lightning doing the reasoning made ${L.clears_made} of ${L.clear_cases} clears against ${U.clears_made} of ${U.clear_cases} and took a median of ${L.median_case_s} s per case against ${U.median_case_s} s`
      : "";
  const perAlert = L
    ? ` (about ${minutes(L.median_case_s)} minutes per alert locally, the median per case of the model-choice study's Lightning arm)`
    : "";
  return `- ${head}${tradeOff}. A held-out v4 study of this mode, three runs per mode, is in progress (${s.runs_found} of ${s.runs_expected} runs exported). 70-case local run: not measured${perAlert}. ${how}`;
}

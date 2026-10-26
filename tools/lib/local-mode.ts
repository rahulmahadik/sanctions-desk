/**
 * The fully local mode study: held-out v4 run three times with every model step on Nemotron 3.5 Lightning on the
 * laptop (the exam's `lightning` variant: decision, critic and challenger sent under the guard identity, which the
 * cockpit binds to the local lane) and three times in the default mode (`routed`). Per run and per arm: risk cases
 * wrongly closed, clears made, unsupported blocks, unusable answers and where they came from (time-outs, answers no
 * decision could be read from), model calls that failed on both providers and what each provider answered, time per
 * case, model calls by the model that served them, and cost (what the receipts record, and the illustrative figure
 * worked out from the unit costs in config/default.json).
 *
 * One summary sentence (renderSummary) is the version every document quotes: the README line, the block in
 * docs/NEMOTRON.md, the item in docs/KNOWN_ISSUES.md and, through the NEMOTRON block, the site's results page.
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

/** What one provider answered when a model call failed, as the trace records it. */
export interface ProviderError {
  provider: string;
  type?: string;
  status?: number;
  message?: string;
  body?: string;
}
export interface TraceEvent {
  agent: string;
  action: string;
  provider?: string | null;
  model_used?: string | null;
  receipt?: { receipt_id?: string } | null;
  /** Present on a model call that failed on every provider (the desk then retried). */
  detail?: { provider_errors?: ProviderError[] } | null;
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

/**
 * Model calls that failed on every provider, and what each provider answered: Nightshift's local lane answering
 * HTTP 502 `empty_response` (an empty answer), timing out, answering 502 `provider_deadline` (the cloud lane) or
 * failing another way; the Ollama backup answering nothing because its answer was cut off by the token limit, or
 * failing another way.
 */
export interface FailedCalls {
  calls: number;
  nightshift_empty_response: number;
  nightshift_timeout: number;
  nightshift_provider_deadline: number;
  nightshift_other: number;
  ollama_token_limit: number;
  ollama_other: number;
}

const noFailures = (): FailedCalls => ({
  calls: 0,
  nightshift_empty_response: 0,
  nightshift_timeout: 0,
  nightshift_provider_deadline: 0,
  nightshift_other: 0,
  ollama_token_limit: 0,
  ollama_other: 0,
});

/** The failed model calls of the five model steps, from the trace's `detail.provider_errors`. */
export function failedCalls(events: readonly TraceEvent[]): FailedCalls {
  const f = noFailures();
  for (const e of events) {
    if (e.action !== "model_answer" || !MODEL_STEPS.has(e.agent)) continue;
    const errors = e.detail?.provider_errors;
    if (!Array.isArray(errors) || errors.length === 0) continue;
    f.calls += 1;
    for (const p of errors) {
      if (p.provider === "nightshift") {
        if (p.type === "timeout" || /timed out/i.test(p.message ?? "")) f.nightshift_timeout += 1;
        else if (/empty_response/.test(p.body ?? "")) f.nightshift_empty_response += 1;
        else if (/provider_deadline/.test(p.body ?? "")) f.nightshift_provider_deadline += 1;
        else f.nightshift_other += 1;
      } else if (p.provider === "ollama") {
        if (/token limit/i.test(p.message ?? "")) f.ollama_token_limit += 1;
        else f.ollama_other += 1;
      }
    }
  }
  return f;
}

function addFailures(runs: readonly { failed_calls: FailedCalls }[]): FailedCalls {
  const out = noFailures();
  for (const r of runs) for (const k of Object.keys(out) as Array<keyof FailedCalls>) out[k] += r.failed_calls[k];
  return out;
}

/** A case that ended with no answer because it timed out, as the result file records it. */
export interface TimedOutCase {
  case_id: string;
  after_s: number;
}

/** The cases a run gave up on (`got: ERROR`, "case timed out after N s"). */
export function timedOutCases(cases: readonly ScoredCase[]): TimedOutCase[] {
  return cases.flatMap((c) => {
    const m = c.got === "ERROR" ? /timed out after (\d+) s/.exec(c.error ?? "") : null;
    return m ? [{ case_id: c.case_id, after_s: Number(m[1]) }] : [];
  });
}

/** Where a run's unusable answers came from: a time-out, an answer no decision could be read from, or another cause. */
export interface UnusableByCause {
  timeout: number;
  parsing: number;
  provider: number;
  withheld: number;
  other: number;
}

export function unusableByCause(cases: readonly ScoredCase[]): UnusableByCause {
  const out: UnusableByCause = { timeout: 0, parsing: 0, provider: 0, withheld: 0, other: 0 };
  for (const c of cases) {
    if (c.got === "ERROR") out[/timed out after \d+ s/.test(c.error ?? "") ? "timeout" : "other"] += 1;
    else if (c.decision_unavailable !== undefined) out[c.decision_unavailable] += 1;
  }
  return out;
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
  unusable_by_cause: UnusableByCause;
  timed_out: TimedOutCase[];
  failed_calls: FailedCalls;
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
    unusable_by_cause: unusableByCause(r.cases),
    timed_out: timedOutCases(r.cases),
    failed_calls: failedCalls(events),
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
  unusable_by_cause: UnusableByCause;
  /** Each case that timed out, with how many of the arm's runs it timed out in. */
  timed_out: Array<TimedOutCase & { runs: number }>;
  failed_calls: FailedCalls;
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
  const causes: UnusableByCause = { timeout: 0, parsing: 0, provider: 0, withheld: 0, other: 0 };
  for (const r of runs)
    for (const k of Object.keys(causes) as Array<keyof UnusableByCause>) causes[k] += r.unusable_by_cause[k];
  const timedOut = new Map<string, TimedOutCase & { runs: number }>();
  for (const r of runs)
    for (const t of r.timed_out) {
      const key = `${t.case_id}@${t.after_s}`;
      const seen = timedOut.get(key);
      if (seen) seen.runs += 1;
      else timedOut.set(key, { ...t, runs: 1 });
    }
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
    unusable_by_cause: causes,
    timed_out: [...timedOut.values()].sort((a, b) => a.case_id.localeCompare(b.case_id)),
    failed_calls: addFailures(runs),
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

/** The limit stated while the study has not been run: no measurement of this mode on held-out v4 or the 70 cases. */
export const NOT_RUN = "Not run yet: a held-out v4 study and a 70-case run in fully local mode.";
/** The limit that stays once the study is in: the 70-case exam has not been run in fully local mode. */
export const NOT_RUN_70 = "Not run: a 70-case run in fully local mode.";

const HOW_TO_RUN = "MODELS.md#fully-local-mode";
const DETAILS = "NEMOTRON.md#fully-local-mode-every-step-on-the-laptop";
const EXPORT_DIR = "eval/studies/local-mode";

/** The two pooled arms of a complete study, or undefined while it is in progress. */
function pooledArms(s: LocalModeStudy): { local: Pooled; def: Pooled } | undefined {
  const local = s.arms.find((a) => a.id === "local")?.pooled;
  const def = s.arms.find((a) => a.id === "default")?.pooled;
  return s.status === "complete" && local && def ? { local, def } : undefined;
}

/**
 * The one summary every document quotes, from the pooled figures: what the fully local mode got right (no wrong
 * close, no cloud call), what it cost (clears, unusable answers, time), the default mode on the same cases, and the
 * verdict that follows. Medians are rounded to whole seconds. Empty while the study is in progress.
 */
export function renderSummary(s: LocalModeStudy, opts: { bold?: boolean } = {}): string {
  const arms = pooledArms(s);
  if (!arms) return "";
  const { local, def } = arms;
  const c = cloudShare(local.calls_by_model);
  const head = opts.bold ? "**Fully local mode**" : "Fully local mode";
  const unusable = (p: Pooled) =>
    p.unusable === 0
      ? "every case answered"
      : `${p.unusable} of ${p.cases} cases without a usable model answer (each held for a person)`;
  const safe = local.wrong_closes === 0 && local.unsupported_blocks === 0 && c.cloud === 0;
  const practical = local.unusable === 0 && local.median_case_s <= def.median_case_s;
  const verdict = !safe
    ? "Fully local mode is not safe on these cases, which is why reasoning runs on Ultra by default."
    : practical
      ? "Fully local mode is safe and practical on this laptop."
      : "Fully local mode is safe but not yet practical on this laptop, which is why reasoning runs on Ultra by default.";
  return `${head} (held-out v4, ${local.runs} runs, ${local.cases} cases): ${local.wrong_closes} of ${local.risk_cases} risk cases wrongly closed and ${c.cloud} of ${c.all} model calls sent to the cloud; but ${local.clears_made} of ${local.clear_cases} clears, ${unusable(local)} and a median of ${Math.round(local.median_case_s)} s per case. With Ultra in the cloud on the same cases: ${def.wrong_closes} of ${def.risk_cases} wrongly closed, ${def.clears_made} of ${def.clear_cases} clears, ${unusable(def)}, median ${Math.round(def.median_case_s)} s. ${verdict}`;
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);
const list = (parts: string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** What one provider answered across an arm's failed calls, in words. */
function providerText(f: FailedCalls): string {
  const nightshift: string[] = [];
  if (f.nightshift_empty_response)
    nightshift.push(`answered HTTP 502 \`empty_response\` (an empty answer) ${times(f.nightshift_empty_response)}`);
  if (f.nightshift_timeout) nightshift.push(`timed out ${times(f.nightshift_timeout)}`);
  if (f.nightshift_provider_deadline)
    nightshift.push(`answered HTTP 502 \`provider_deadline\` ${times(f.nightshift_provider_deadline)}`);
  if (f.nightshift_other) nightshift.push(`failed another way ${times(f.nightshift_other)}`);
  const ollama: string[] = [];
  if (f.ollama_token_limit) ollama.push(`answered nothing, cut off by its token limit, ${times(f.ollama_token_limit)}`);
  if (f.ollama_other) ollama.push(`failed another way ${times(f.ollama_other)}`);
  return `Nightshift ${list(nightshift) || "recorded no error"}; the Ollama backup then ${list(ollama) || "recorded no error"}`;
}

/**
 * Where the unusable answers came from and what failed behind them, from the result files and the traces: the cases
 * that timed out (which, after how long, in how many runs), the answers no decision could be read from, and the model
 * calls that failed on both providers with what each provider answered. The same paragraph in NEMOTRON.md and
 * KNOWN_ISSUES.md. Empty while the study is in progress.
 */
export function renderCauses(s: LocalModeStudy): string {
  const arms = pooledArms(s);
  if (!arms) return "";
  const { local, def } = arms;
  const u = local.unusable_by_cause;
  const timedOut = local.timed_out.map((t) => `${t.case_id} after ${t.after_s} s in ${t.runs} of ${local.runs} runs`);
  const parts: string[] = [];
  if (u.timeout) parts.push(`${u.timeout} ${u.timeout === 1 ? "case" : "cases"} timed out (${list(timedOut)})`);
  if (u.parsing) parts.push(`${u.parsing} ${u.parsing === 1 ? "answer" : "answers"} no decision could be read from`);
  if (u.provider) parts.push(`${u.provider} with no answer from any provider`);
  if (u.withheld) parts.push(`${u.withheld} withheld`);
  if (u.other) parts.push(`${u.other} with another error`);
  const lf = local.failed_calls;
  const df = def.failed_calls;
  return [
    local.unusable
      ? `Where the fully local arm's ${local.unusable} unusable answers came from: ${list(parts)}.`
      : "Every case in the fully local arm got a usable answer.",
    lf.calls
      ? `Behind them, ${lf.calls} model calls failed on both providers and were retried: ${providerText(lf)}.`
      : "No model call failed on both providers.",
    `In the default arm ${df.calls === 0 ? "no model call" : `${df.calls} model ${df.calls === 1 ? "call" : "calls"}`} failed on both providers${df.calls ? ` (${providerText(df)}); each was recovered by a retry` : ""}.`,
  ].join(" ");
}

/** The block between the local-mode markers in docs/NEMOTRON.md. */
export function renderDocBlock(
  s: LocalModeStudy,
  choice: { ultra?: ModelChoiceArm; lightning?: ModelChoiceArm },
): string {
  const lead = `Every model step (safety guard, screener, decision, critic and challenger) on Nemotron 3.5 Lightning on the laptop: the decision, critic and challenger are sent under the guard identity, which the cockpit binds to the local lane, and the Ollama backup is the same model on the same machine, so all data and models stay on the machine. How to run it: [MODELS.md](${HOW_TO_RUN}).`;
  if (s.status !== "complete") {
    const earlier =
      choice.ultra && choice.lightning
        ? ` The only measurement so far of Lightning doing the reasoning is the model-choice study above: a median of ${choice.lightning.median_case_s} s per case against ${choice.ultra.median_case_s} s, ${choice.lightning.clears_made} of ${choice.lightning.clear_cases} clears made against ${choice.ultra.clears_made} of ${choice.ultra.clear_cases}, ${choice.lightning.wrong_closes} of ${choice.lightning.risk_cases} risk cases wrongly closed in both arms${choice.ultra.wrong_closes === choice.lightning.wrong_closes ? "" : ` (default: ${choice.ultra.wrong_closes} of ${choice.ultra.risk_cases})`}.`
        : "";
    return `**Fully local mode.** ${lead} ${NOT_RUN}${earlier}`;
  }
  const rows = s.arms.flatMap((a) => (a.pooled ? [{ a, p: a.pooled }] : []));
  const local = s.arms.find((a) => a.id === "local")?.pooled;
  const cloudLocal = local ? cloudShare(local.calls_by_model) : { cloud: 0, all: 0 };
  return [
    `**${s.label}.** ${renderSummary(s)} ${NOT_RUN_70}`,
    "",
    `${lead} Each arm is held-out v4 (12 cases: 6 risk cases, 6 clears) run three times, Nightshift warmed up and not restarted; the counts are pooled over the three runs, with 95% Wilson ranges in brackets. An unsupported block is a block recommendation on a case whose labels do not accept a block. Result file: [eval/local-mode.json](../eval/local-mode.json); runs, traces and receipts: \`${EXPORT_DIR}\` ([eval/studies](../eval/studies/README.md)).`,
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
    renderCauses(s),
    "",
    `Cost, per arm over its three runs: ${rows.map(({ a, p }) => `${a.label}: ${costLabel(p.recorded_cost, p.illustrative_usd, s.unit_costs)}`).join("; ")}.`,
  ].join("\n");
}

/** The README line: the one summary once the study is complete; before that, the option and the earlier measurement. */
export function renderReadmeLine(
  s: LocalModeStudy,
  choice: { ultra?: ModelChoiceArm; lightning?: ModelChoiceArm },
): string {
  const how = `How to run it: [docs/MODELS.md](docs/${HOW_TO_RUN}).`;
  if (pooledArms(s)) {
    return `- ${renderSummary(s, { bold: true })} ${NOT_RUN_70} Details: [docs/NEMOTRON.md](docs/${DETAILS}). ${how}`;
  }
  const head =
    "**Fully local mode:** every step runs on Nemotron 3.5 Lightning on the laptop, so all data and models stay on the machine. It is an option with a trade-off";
  const L = choice.lightning;
  const U = choice.ultra;
  const tradeOff =
    L && U
      ? `. In the model-choice study (20 cases, one run per arm), Lightning doing the reasoning made ${L.clears_made} of ${L.clear_cases} clears against ${U.clears_made} of ${U.clear_cases}. It took a median of ${L.median_case_s} s per case against ${U.median_case_s} s`
      : "";
  return `- ${head}${tradeOff}. ${NOT_RUN} ${how}`;
}

/** The item between the local-mode markers in docs/KNOWN_ISSUES.md (under Measurement limits). */
export function renderKnownIssuesItem(s: LocalModeStudy): string {
  if (!pooledArms(s))
    return `- **Fully local mode on held-out v4:** not measured yet (every step on Lightning on the laptop; how to run it: [MODELS.md](${HOW_TO_RUN})). ${NOT_RUN}`;
  return `- ${renderSummary(s, { bold: true })} ${renderCauses(s)} ${NOT_RUN_70} Runs, traces and receipts: \`${EXPORT_DIR}\` ([eval/studies](../eval/studies/README.md)); the tables: [NEMOTRON.md](${DETAILS}); how to run it: [MODELS.md](${HOW_TO_RUN}).`;
}

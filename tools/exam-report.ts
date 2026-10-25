/**
 * Build eval/REPORT.md, the headline and key-results blocks in README.md, the held-out round story in
 * docs/EVALUATION.md and the binds table in docs/MODELS.md from the saved exam results (the newest complete run
 * of each variant). Nothing here is typed in by hand: every number comes from a results file written by
 * `npm run exam`, apart from the minutes-saved figure, which rests on the assumptions in `config/default.json`
 * (`report`) and says so.
 *
 *   npm run exam:report
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  byPath,
  type Headline,
  headlineOf,
  heldoutRounds,
  type Metrics,
  modelLabel,
  ROUND_COLUMN_LABEL,
  ROUND_COLUMNS,
  type RoundCell,
  type RoutingSplit,
  routingSplit,
  type SavedResult,
  type ScoredCase,
  summarise,
} from "@sanctions-desk/agents";
import { loadExam } from "@sanctions-desk/data";
import { loadConfig, resolveProjectPath, wilson95 as wilsonInterval } from "@sanctions-desk/shared";
import {
  answerSources,
  armRows,
  closed,
  examArms,
  examFigures,
  heldoutSummary,
  heldoutTotals,
  heldoutTotalsTable,
  range95,
  riskOf,
  rulesFraming,
} from "./lib/exam-figures.js";
import { formatMarkdown } from "./lib/format-markdown.js";

interface Features {
  commit?: string;
  commit_at_end?: string;
  structured_output?: boolean;
  challenger?: { enabled: boolean };
  provider_backoff_ms?: number;
  challenger_points?: string;
  cockpit_binds?: Record<string, string>;
  with_free_text?: boolean;
}

interface LabelSet {
  expected: string;
  acceptable: string[];
  must_not: string[];
}

interface Result {
  features?: Features;
  variant: string;
  /** The version of the system under test (for example sys2); absent for the first system. */
  system?: string;
  tag?: string;
  /** "heldout" for a run of the held-out set; absent for the main exam. */
  exam?: string;
  selection?: { groups?: string[]; kinds?: number; limit?: number };
  started_at: string;
  policy_version: number;
  models: Record<string, string>;
  cases: ScoredCase[];
  metrics: Metrics;
}

const dir = resolveProjectPath("eval/results");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.startsWith("bench-"))
  .sort();
const exam = loadExam();
const labels = new Map(exam.cases.map((c) => [c.case_id, c]));

const changesPath = resolveProjectPath("eval/label-changes.json");
type LabelChange = { case_id: string; original: LabelSet; revised: LabelSet };
const labelChanges: LabelChange[] = existsSync(changesPath)
  ? (JSON.parse(readFileSync(changesPath, "utf8")) as { changes: never[] }).changes
  : [];
const originalLabels = new Map(labelChanges.map((c) => [c.case_id, c.original]));

/**
 * Score a saved run against the labels in the committed exam, so a label that changed applies to every variant.
 * With `original`, the labels that were changed after the first full run are put back as they were.
 */
function rescore(r: Result, original = false): Result {
  const cases = r.cases.map((c) => {
    const l = labels.get(c.case_id);
    if (!l) return c;
    const o = original ? originalLabels.get(c.case_id) : undefined;
    return {
      ...c,
      expected: o?.expected ?? l.expected,
      acceptable: o?.acceptable ?? l.acceptable,
      must_not: o?.must_not ?? l.must_not,
    };
  });
  return { ...r, cases, metrics: summarise(cases) };
}

const originalScore = new Map<string, Metrics>();
const newest = new Map<string, Result & { file: string }>();
/** Complete runs of a variant that a newer complete run has replaced, kept for comparison. */
const earlier: Array<Result & { file: string; original?: Metrics }> = [];
for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Result;
  const partial =
    r.exam !== undefined ||
    r.system !== undefined ||
    r.tag !== undefined ||
    r.selection?.kinds ||
    r.selection?.groups ||
    r.selection?.limit;
  if (!partial) {
    const previous = newest.get(r.variant);
    if (previous) earlier.push({ ...previous, original: originalScore.get(r.variant) });
    newest.set(r.variant, { ...rescore(r), file: f });
    originalScore.set(r.variant, rescore(r, true).metrics);
  }
}

/** Newest complete runs of later system versions and of baselines on the second held-out set, by "system|exam|variant". */
const laterRuns = new Map<string, Result & { file: string }>();
/** The newest complete run of each variant on the held-out set, scored against the held-out labels. */
const heldoutNewest = new Map<string, Result & { file: string }>();
for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Result;
  const whole = r.tag === undefined && !r.selection?.kinds && !r.selection?.groups && !r.selection?.limit;
  if (r.exam === "heldout" && r.system === undefined && whole)
    heldoutNewest.set(r.variant, { ...r, metrics: summarise(r.cases), file: f });
  // Runs of a later system version, kept apart so they never replace the first system's numbers.
  // Exam runs are scored against the current labels, like the first system's runs (the held-out labels never changed).
  if (r.system !== undefined && whole)
    laterRuns.set(`${r.system}|${r.exam ?? "exam"}|${r.variant}`, {
      ...(r.exam === undefined ? rescore(r) : { ...r, metrics: summarise(r.cases) }),
      file: f,
    });
  if (["heldout2", "heldout3", "heldout4"].includes(r.exam ?? "") && r.system === undefined && whole)
    laterRuns.set(`baseline|${r.exam}|${r.variant}`, { ...r, metrics: summarise(r.cases), file: f });
}

const config = loadConfig();
const assumptions = config.report;
const alertCases = exam.cases.filter((c) => c.alert_id !== null).length;
const draftCases = exam.cases.length - alertCases;

/** The trace events of a variant's cases at or after `since` whose line contains `needle`. */
function* traceEvents<T extends { ts: string }>(variant: string, since: string, needle: string): Generator<T> {
  const logs = resolveProjectPath(config.logging.dir);
  if (!existsSync(logs)) return;
  for (const name of readdirSync(logs).filter((n) => n.startsWith(`trace-eval-${variant}-`))) {
    for (const line of readFileSync(join(logs, name), "utf8").split("\n")) {
      if (!line.includes(needle)) continue;
      const e = JSON.parse(line) as T;
      if (e.ts >= since) yield e;
    }
  }
}

/** What the challenger concluded in each of this run's challenges, from the run's traces. */
function challengerOutcomes(variant: string, since: string) {
  const out = { total: 0, none: 0, credible: 0, unavailable: 0 };
  for (const e of traceEvents<{ ts: string; status: string }>(variant, since, '"action":"challenge_result"')) {
    out.total += 1;
    if (e.status === "ok") out.none += 1;
    else if (e.status === "blocked") out.credible += 1;
    else out.unavailable += 1;
  }
  return out;
}

interface ModelAnswerEvent {
  ts: string;
  agent: string;
  retry_count?: number;
  model_requested?: string;
  output_summary?: string;
  detail?: { lane?: string; structured?: boolean };
}

const ENTRY_LANE: Record<string, string> = {
  decision: "deep",
  critic: "judge",
  challenger: "deep",
  policy_guard: "fast",
};

/** The mode a call asked for: logged for newer runs, inferred from the step and the try for older ones. */
function modeAskedFor(e: ModelAnswerEvent, failed: boolean): string {
  const raw =
    e.detail?.lane ??
    e.model_requested ??
    (failed ? ([ENTRY_LANE[e.agent], "fast", "ollama"][Math.min(e.retry_count ?? 0, 2)] as string) : "unknown");
  return raw.replace("meterless/", "");
}

/**
 * How the model calls went in a run, from its traces: calls and provider failures (a call that ended before any
 * answer, because every provider failed) by the mode asked for, and any answer that was not schema-constrained.
 */
function callStats(variant: string, since: string) {
  const lanes = new Map<string, { calls: number; failed: number }>();
  const failedBy = new Map<string, number>();
  let unstructured = 0;
  for (const e of traceEvents<ModelAnswerEvent>(variant, since, '"action":"model_answer"')) {
    if (!(e.agent in ENTRY_LANE)) continue;
    const failed = /^model call failed/.test(e.output_summary ?? "");
    const lane = modeAskedFor(e, failed);
    const row = lanes.get(lane) ?? { calls: 0, failed: 0 };
    row.calls += 1;
    if (failed) {
      row.failed += 1;
      failedBy.set(`${e.agent} on \`${lane}\``, (failedBy.get(`${e.agent} on \`${lane}\``) ?? 0) + 1);
    } else if (e.agent !== "policy_guard" && e.detail?.structured !== true) {
      unstructured += 1;
    }
    lanes.set(lane, row);
  }
  return { lanes, failedBy, unstructured };
}

/** One label change in words: an added acceptable answer, or a new expected answer. */
function describeLabelChange(c: LabelChange): string {
  if (c.original.expected === c.revised.expected) {
    const added = c.revised.acceptable.filter((a) => !c.original.acceptable.includes(a));
    return `${c.case_id} gained ${added.join(" and ")} as an acceptable answer`;
  }
  const miss = c.revised.must_not.includes("CLOSE_FALSE_POSITIVE") ? " (a close is now a miss)" : "";
  return `${c.case_id} was relabelled from ${c.original.expected} to ${c.revised.expected}${miss}`;
}

/** What the receipts say about the mode served: the runtime's own \`auto\` before the cockpit binds, the bound mode after. */
function servedModeSentence(split: { receipts: number; routed_auto: number }): string {
  if (split.routed_auto === split.receipts) {
    return `In all ${split.receipts} receipts read, the mode served was the runtime's own \`auto\`.`;
  }
  if (split.routed_auto === 0) {
    return `In all ${split.receipts} receipts read, the mode served was the one the app identity is bound to in the cockpit, not the runtime's own \`auto\`.`;
  }
  return `In ${split.receipts - split.routed_auto} of the ${split.receipts} receipts read, the mode served was the one the app identity is bound to in the cockpit; in ${split.routed_auto} it was the runtime's own \`auto\`.`;
}

function splitTable(split: RoutingSplit): string[] {
  const models = [...new Set(split.rows.flatMap((r) => r.models.map((m) => m.model)))].sort();
  const head = models.map(
    (m) => `${modelLabel(m)} (${split.rows.flatMap((r) => r.models).find((x) => x.model === m)?.kind})`,
  );
  const out = [`| Step | Calls | ${head.join(" | ")} |`, `|---|---:|${models.map(() => "---:").join("|")}|`];
  for (const r of split.rows) {
    const cells = models.map((m) => {
      const x = r.models.find((y) => y.model === m);
      return x ? `${pct(x.share)} (${x.calls})` : "0";
    });
    out.push(`| ${r.step} | ${r.calls} | ${cells.join(" | ")} |`);
  }
  return out;
}

const OUTCOMES = [
  "CLOSE_FALSE_POSITIVE",
  "NEED_MORE_INFO",
  "ESCALATE_L2",
  "RECOMMEND_BLOCK",
  "DRAFT_BLOCKED",
  "DRAFT_ALLOWED",
  "ERROR",
];
const SHORT: Record<string, string> = {
  CLOSE_FALSE_POSITIVE: "close",
  NEED_MORE_INFO: "more info",
  ESCALATE_L2: "escalate",
  RECOMMEND_BLOCK: "block",
  DRAFT_BLOCKED: "draft blocked",
  DRAFT_ALLOWED: "draft allowed",
  ERROR: "error",
};
const CAUTION: Record<string, number> = {
  CLOSE_FALSE_POSITIVE: 0,
  NEED_MORE_INFO: 1,
  ESCALATE_L2: 2,
  RECOMMEND_BLOCK: 3,
};

/** Expected outcome (rows) against the outcome the variant gave (columns). */
function confusionMatrix(cases: readonly ScoredCase[]): string[] {
  const got = OUTCOMES.filter((o) => cases.some((c) => c.got === o));
  const expected = OUTCOMES.filter((o) => cases.some((c) => c.expected === o));
  const out = [
    `| Expected \\ Got | ${got.map((g) => SHORT[g]).join(" | ")} | Total |`,
    `|---|${got.map(() => "---:").join("|")}|---:|`,
  ];
  for (const e of expected) {
    const row = cases.filter((c) => c.expected === e);
    out.push(
      `| ${SHORT[e]} | ${got.map((g) => row.filter((c) => c.got === g).length || "").join(" | ")} | ${row.length} |`,
    );
  }
  return out;
}

/** Why a case counts as acceptable but not exact, or as neither: the kind of gap, in plain words. */
function gapKind(c: ScoredCase): string {
  const acceptable = c.acceptable.includes(c.got);
  if (acceptable && c.expected === "ESCALATE_L2" && c.got === "RECOMMEND_BLOCK") {
    return "label granularity: a recommended block is the stronger form of an escalation, and still needs two human approvals";
  }
  const more = (CAUTION[c.got] ?? 0) > (CAUTION[c.expected] ?? 0);
  if (acceptable && more)
    return "cautious choice: the desk sent it to a person where the exam expected a lighter outcome";
  if (acceptable) return "acceptable alternative";
  if (c.decision_unavailable) return `no usable model decision (${c.decision_unavailable}); escalated for that reason`;
  if (more && c.critic_final === "escalated") {
    return "real error, in the safe direction: the model cited something that does not exist three times and the critic would not approve it";
  }
  if (more) return "miss in the safe direction: more cautious than the exam allows";
  return "real error, in the unsafe direction";
}

/** The gap between exact and acceptable (and the misses) as a table: one row per pair of outcomes. */
function gapTable(cases: readonly ScoredCase[]): string[] {
  const pairs = new Map<string, ScoredCase[]>();
  for (const c of cases.filter((x) => x.got !== x.expected)) {
    const key = `${SHORT[c.expected]} → ${SHORT[c.got]} | ${gapKind(c)}`;
    pairs.set(key, [...(pairs.get(key) ?? []), c]);
  }
  const out = ["| Expected → got | What it is | Cases |", "|---|---|---|"];
  for (const [key, list] of [...pairs].sort((a, b) => b[1].length - a[1].length)) {
    const [pair, kind] = key.split(" | ") as [string, string];
    out.push(`| ${pair} (${list.length}) | ${kind} | ${list.map((c) => `${c.case_id} ${c.kind}`).join(", ")} |`);
  }
  return out;
}

/** For the earlier-clearance cases of a run: was the earlier decision recalled, was its pointer still valid, was it used. */
function memoryRecall(variant: string, since: string) {
  const logs = resolveProjectPath(config.logging.dir);
  const folder = join(logs, "records");
  const cases = exam.cases.filter((c) => c.group === "previously_cleared_unchanged");
  const result = { cases: cases.length, recalled: 0, valid: 0, used: 0 };
  if (!existsSync(folder)) return result;
  const records = readdirSync(folder)
    .filter((n) => n.endsWith(".json"))
    .map(
      (n) =>
        JSON.parse(readFileSync(join(folder, n), "utf8")) as {
          run_id: string;
          decided_at: string;
          memories: Array<{ pointer_states: string[]; used: boolean }>;
        },
    )
    .filter((r) => r.decided_at >= since);
  for (const c of cases) {
    const latest = records
      .filter((r) => r.run_id === `eval-${variant}-${c.case_id}`)
      .sort((a, b) => b.decided_at.localeCompare(a.decided_at))[0];
    const memory = latest?.memories[0];
    if (!memory) continue;
    result.recalled += 1;
    if (memory.pointer_states.every((s) => s === "fresh")) result.valid += 1;
    if (memory.used) result.used += 1;
  }
  return result;
}

const ORDER = ["routed", "single", "no_memory", "local", "rules", "fuzzy", "escalate_all"];
const LABEL: Record<string, string> = {
  routed: "Full system (Nemotron models through Nightshift, critic, challenger, memory)",
  single: "Single recommendation (no critic, no challenger, no memory)",
  no_memory: "Full system with memory off (earlier-cleared cases only)",
  local:
    "Full system asking for the fast mode only, no reasoning budget (Nightshift still decides which model serves it)",
  rules: "Deterministic pipeline (our own matching, ownership and policy code; no language model)",
  fuzzy: "Name-match rules baseline (name score at or above 0.90 escalates, below closes)",
  escalate_all: "Baseline: every alert goes to a person",
};
const have = ORDER.filter((v) => newest.has(v));
const notRun = ORDER.filter((v) => !newest.has(v));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pct0 = (n: number) => `${(n * 100).toFixed(0)}%`;
const get = (v: string) => newest.get(v);

/**
 * Calls per serving model of a run, counted from its exported signed receipts (the model each receipt says won the
 * route), plus the Ollama backup answers from its trace, which carry no receipt. Undefined when the run is not exported.
 */
function receiptCounts(startedAt: string): { cloud: number; local: number; backup: number } | undefined {
  const runs = resolveProjectPath("eval/runs");
  const dir = readdirSync(runs).find((d) => {
    const meta = join(runs, d, "run-meta.json");
    return (
      existsSync(meta) && (JSON.parse(readFileSync(meta, "utf8")) as { started_at?: string }).started_at === startedAt
    );
  });
  if (!dir || !existsSync(join(runs, dir, "receipts.jsonl.gz"))) return undefined;
  const jsonl = (file: string) =>
    gunzipSync(readFileSync(join(runs, dir, file)))
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  const counts = { cloud: 0, local: 0, backup: 0 };
  for (const env of jsonl("receipts.jsonl.gz")) {
    const model = String(env.body?.receipt?.winning_route?.model ?? "");
    if (/^local-runtime\/|lightning/i.test(model)) counts.local += 1;
    else counts.cloud += 1;
  }
  for (const e of jsonl("trace.jsonl.gz"))
    if (e.action === "model_answer" && e.provider === "ollama") counts.backup += 1;
  return counts;
}

const lines: string[] = [];
const full = get("routed");
const head: Headline | undefined = full
  ? headlineOf(full.cases, { ...assumptions, currency: config.costs.currency })
  : undefined;

lines.push("# Exam report", "");
lines.push("## Headline", "");
if (head && full) {
  lines.push(
    `Measured on the full system (${full.variant}, ${head.alerts} alert cases, run started ${full.started_at}):`,
    "",
    `- **Closed with cited evidence:** ${head.closed_with_evidence} of ${head.alerts} alerts (${pct0(head.closed_share)}); ${head.closed_correctly} of them rightly. A person still confirms each close, from the evidence the desk cites.`,
    `- **Escalated:** ${head.escalated} of ${head.alerts} alerts (${pct0(head.escalated_share)}), including ${head.decision_unavailable} escalated only because no model decision was usable.`,
    `- **False closes on cases that carry real risk:** ${head.false_closes} of ${head.risk_cases} (${pct(head.false_close_rate)}); on the ${head.true_match_cases} true matches: ${head.true_match_false_closes}. The target is 0.`,
    `- **Time and cost per alert:** the desk took a median of ${head.per_alert.median_seconds.toFixed(0)} seconds (p95 ${head.per_alert.p95_seconds.toFixed(0)} s) over the ${head.per_alert.alerts} alerts (the tables below give ${full.metrics.latency_s.p50} s over all ${full.cases.length} cases, which include the draft checks; every median here is the middle measured value, the lower one for an even count) and ${head.per_alert.mean_cost.toFixed(4)} ${config.costs.currency} in model cost per alert under the illustrative unit costs in \`config/default.json\` (Nightshift's receipts record USD 0), for the recommendation only; a person still decides.`,
    "- **Analyst time saved: not measured, and not claimed.** What the desk removes is the gathering and cross-checking of the evidence; how many minutes that saves a team was not measured.",
    "",
  );
} else {
  lines.push("_The full system has not been run yet, so there is no headline figure._", "");
}

// ---- the results in the order that matters ---------------------------------------------------------

/** The two directions on the held-out set: risks caught, and clears correctly made. */
function directions(cases: readonly ScoredCase[]) {
  const risk = riskOf(cases).filter((c) => c.error === undefined);
  const clears = cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE" && c.error === undefined);
  const caught = risk.filter((c) => !closed(c)).length;
  const made = clears.filter(closed).length;
  const acceptable = cases.filter((c) => c.error === undefined && summariseOne(c)).length;
  return { risk: risk.length, caught, clears: clears.length, made, acceptable, total: cases.length };
}
const summariseOne = (c: ScoredCase): boolean => c.got === c.expected || c.acceptable.includes(c.got);

/** Notes on specific held-out v1 cases, from the trace analysis. The labels are frozen and are not changed. */
const HELDOUT_V1_NOTES: Record<string, string> = {
  "HO-030":
    "label conflicts with the written policy (a failing data-quality rule cannot support a close); left unchanged because frozen",
};

const NAME_MATCH = "Name-match rules baseline";
const mainRow = (label: string, r: Result | undefined) =>
  r
    ? `| ${label} | ${r.metrics.false_closes} of ${r.metrics.risk_cases} (${pct(r.metrics.false_close_rate)}) | ${pct0(r.metrics.acceptable_accuracy)} | ${r.metrics.latency_s.p50} |`
    : `| ${label} | not run | | |`;
lines.push(
  "### (a) Against plain name matching, on the 70 cases",
  "",
  "Name matching is typical screening: it sees a name score and nothing else. The row to read is how many cases that carry real risk each one wrongly recommends closing.",
  "",
  "| System | Risk cases wrongly closed | Acceptable answers | Median s |",
  "|---|---:|---:|---:|",
  mainRow("Full system (agents, critic, challenger, memory)", full),
  mainRow(`${NAME_MATCH} (score at or above 0.90 escalates)`, get("fuzzy")),
  mainRow("Every alert goes to a person", get("escalate_all")),
  "",
);

// ---- the 70 cases, five ways --------------------------------------------------------------------------------------
// The arms and their figures come from tools/lib/exam-figures.ts, which the Nemotron scorecard uses too. The current
// system was run twice on the 70 cases: sys5 on the code before the block fix (commit 16e0dae), and sys6 on the fixed
// code. A row whose run does not exist yet says so, and fills in from its result file once it does.
const arms = examArms(
  files.map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Result), file: f })),
  labels,
);
const beforeBlockFix = arms.beforeBlockFix;
const currentSystem = arms.current;
const runsDir = resolveProjectPath("eval/runs");
const runDirs = existsSync(runsDir) ? readdirSync(runsDir).map((d) => join(runsDir, d)) : [];
// Every held-out round, from heldoutRounds, the same function the review desk's test-scores screen uses.
const rounds = heldoutRounds(
  files.map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as SavedResult) })),
);
const totals = heldoutTotals(rounds);
const framing = rulesFraming(arms.rules ? examFigures(arms.rules) : undefined, totals);
/** The trade-off between the full system and Nemotron alone, in words, from the result files. */
function tradeOffLines(): string[] {
  const sys = currentSystem ?? beforeBlockFix ?? full;
  const alone = arms.aloneWith ?? arms.aloneWithout;
  if (!sys || !alone) return [];
  const a = examFigures(alone);
  const f = examFigures(sys);
  const which = alone === arms.aloneWith ? "with the free text" : "without the free text";
  return [
    `**The trade-off, read plainly.** Nemotron alone (${which}; decision answers used: ${answerSources(alone, runDirs)}) clears more: ${a.made} of ${a.clears} clear cases, against ${f.made} of ${f.clears} for the full system. But it wrongly closes ${a.wrong} of ${a.risk} risk cases (${range95(a.wrong, a.risk)}) and recommends a block on ${a.blocks} cases, ${a.unsupportedBlocks} of them unsupported by the labels (${a.unsupportedBlocks} of ${a.notBlockCases}, ${range95(a.unsupportedBlocks, a.notBlockCases)}). The full system (${sys === currentSystem ? CURRENT_LABEL : sys === beforeBlockFix ? BEFORE_LABEL : FIRST_LABEL}) wrongly closes ${f.wrong} of ${f.risk}, recommends ${f.unsupportedBlocks} unsupported blocks (${f.unsupportedBlocks} of ${f.notBlockCases}), and leaves the final call to a person.`,
  ];
}
const FIRST_LABEL = "the first system";
const BEFORE_LABEL = "the current system before the block fix";
const CURRENT_LABEL = "the current system";
/** The comparison of the full-system runs on the 70 cases, and why blocks went from some to none and back. */
function blockFixLines(link: (file: string) => string, withStory = true): string[] {
  if (!full || !beforeBlockFix) return [];
  const one = (label: string, r: Result & { file: string }) => {
    const f = examFigures(r);
    return `${label} ([result](${link(r.file)})): ${f.wrong} of ${f.risk} risk cases wrongly closed (${range95(f.wrong, f.risk)}), ${f.made} of ${f.clears} clears made (${range95(f.made, f.clears)}), median ${Math.round(f.median)} s per case, ${f.unusable} unusable answers, ${f.blocks} blocks recommended, ${f.moreInfo} need-more-information ${f.moreInfo === 1 ? "outcome" : "outcomes"}`;
  };
  const a = examFigures(full);
  const b = examFigures(beforeBlockFix);
  const shown = [full, beforeBlockFix, currentSystem].filter((r): r is Result & { file: string } => r !== undefined);
  const overlaps = (pick: (f: ReturnType<typeof examFigures>) => [number, number]) => {
    const iv = shown.map((r) => {
      const [k, n] = pick(examFigures(r));
      return wilsonInterval(k, n);
    });
    return Math.max(...iv.map((x) => x.low)) <= Math.min(...iv.map((x) => x.high));
  };
  const clearsOverlap = overlaps((f) => [f.made, f.clears]);
  const overlap = clearsOverlap
    ? "the ranges of clears made overlap, so one run each cannot show whether clears really differ"
    : "the ranges of clears made do not all overlap";
  const blockedFirst = full.cases.filter((c) => c.got === "RECOMMEND_BLOCK");
  const after = new Map(beforeBlockFix.cases.map((c) => [c.case_id, c]));
  const changed = blockedFirst.filter((c) => after.get(c.case_id)?.got !== "RECOMMEND_BLOCK");
  const gotThen = [...new Set(changed.map((c) => after.get(c.case_id)?.got ?? "not run"))];
  const allAcceptable = changed.every((c) => {
    const x = after.get(c.case_id);
    return x !== undefined && (x.got === x.expected || x.acceptable.includes(x.got));
  });
  const reRun = currentSystem
    ? (() => {
        const c = examFigures(currentSystem);
        const blocked = currentSystem.cases.filter((x) => x.got === "RECOMMEND_BLOCK").map((x) => x.case_id);
        const back = changed.filter((x) => blocked.includes(x.case_id)).map((x) => x.case_id);
        return `Re-measured on the fixed code: ${one(CURRENT_LABEL, currentSystem)}. It recommended ${c.blocks} ${c.blocks === 1 ? "block" : "blocks"}${blocked.length > 0 ? ` (${blocked.join(", ")})` : ""}; ${back.length} of the ${changed.length} cases the first system blocked are blocks again.`;
      })()
    : `Re-measured on the fixed code: the re-run of the current system is in progress; ${withStory ? "its row in the table above and this sentence fill in" : "its figures fill in here"} from its result file when it is saved.`;
  return [
    `**The full system's runs on the 70 cases, from the result files.** ${one(`${FIRST_LABEL[0]?.toUpperCase()}${FIRST_LABEL.slice(1)}`, full)}. ${one(`${BEFORE_LABEL[0]?.toUpperCase()}${BEFORE_LABEL.slice(1)}`, beforeBlockFix)}. ${currentSystem ? one(`${CURRENT_LABEL[0]?.toUpperCase()}${CURRENT_LABEL.slice(1)}`, currentSystem) : "The current system: not run yet"}. Every figure is one run, and the ranges are 95% Wilson score intervals: ${overlap}.`,
    "",
    withStory
      ? `**Blocks recommended: ${a.blocks} in the first system's run, ${b.blocks} in the run of ${BEFORE_LABEL}.** A code change made after the first system's run caused it. Commit \`adffcd8\` (a first finding from code, and a confirm or reason path for every review) gave the decision step code's first finding; \`chooseDecision\` in \`packages/agents/src/sample-rules.ts\` mapped a met true-match definition to ESCALATE_L2 on the confirm path, and the decision prompt says to confirm a settled finding, so the decision step stopped proposing RECOMMEND_BLOCK. It was found by comparing the run of the current system before the block fix with the first system's run: ${changed.length} cases the first system blocked (${changed.map((c) => c.case_id).join(", ")}) came out as ${gotThen.join(" or ")} instead${allAcceptable ? `; ${gotThen.join(" or ")} is acceptable for each of them, so none was wrongly closed` : ""}. Fixed in commit \`16e0dae\`: a met true-match definition is RECOMMEND_BLOCK (still approved by two different people), checked first so nothing turns it into a close; a counterparty match, a document-number match and a strong assessment stay ESCALATE_L2. ${reRun}`
      : `**Blocks recommended: ${a.blocks} in the first system's run, ${b.blocks} in the run of ${BEFORE_LABEL}** (cases ${changed.map((c) => c.case_id).join(", ")} came out as ${gotThen.join(" or ")}). ${reRun}`,
  ];
}
if (armRows(arms).some((a) => a.run !== undefined)) {
  const fiveRow = (label: string, r: (Result & { file: string }) | undefined) => {
    if (!r) return `| ${label} | not run yet | | | | | | | |`;
    const f = examFigures(r);
    return `| ${label} | ${f.wrong} of ${f.risk} (${range95(f.wrong, f.risk)}) | ${f.made} of ${f.clears} (${range95(f.made, f.clears)}) | ${f.escalated} of ${f.cases} | ${f.blocks} | ${f.unsupportedBlocks} of ${f.notBlockCases} (${range95(f.unsupportedBlocks, f.notBlockCases)}) | ${f.unusable} | ${answerSources(r, runDirs)} | [result](results/${r.file}) |`;
  };
  lines.push(
    "### (a2) The 70 cases, five ways",
    "",
    "The same 70 cases through the full system (the first system's run, and runs of the current system before and after the block fix), the deterministic rules, plain name matching, and Nemotron alone: one call per case on the structured case facts, asking for the deep lane, once without and once with the free text the screener reads. The arm with the free text sends that (synthetic) text to the cloud model, which the desk itself never does; it is a study arm only. An unusable answer is a case where no model answer could be used (the full system then escalates it to a person; for Nemotron alone it is left without an outcome). Ranges are 95% Wilson score intervals.",
    "",
    "| System | Risk cases wrongly closed | Clear cases closed | Escalated | Blocks recommended | Unsupported blocks | Unusable answers | Decision answer used came from | File |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
    ...armRows(arms).map((a) => fiveRow(a.label, a.run)),
    "",
    ...heldoutTotalsTable(heldoutSummary(totals)),
    "",
    "An unsupported block is a block recommendation on a case whose labels do not accept a block: an accusation the case does not support. It is counted over the cases whose labels do not accept a block (on the other cases, the true matches and some escalations, the labels accept a block as well as an escalation). The last column counts, per case, the model whose decision answer was used, from the run's exported trace.",
    "",
    framing,
    "",
    ...tradeOffLines(),
    "",
    ...blockFixLines((file) => `results/${file}`),
    "",
  );
}

const hoFull = heldoutNewest.get("routed");
if (heldoutNewest.size > 0) {
  const hoRow = (label: string, r: Result | undefined) => {
    if (!r) return `| ${label} | not run | | | |`;
    const d = directions(r.cases);
    return `| ${label} | ${d.caught} of ${d.risk} (${pct0(d.caught / d.risk)}) | ${d.made} of ${d.clears} (${pct0(d.made / d.clears)}) | ${d.clears - d.made} of ${d.clears} (${pct0((d.clears - d.made) / d.clears)}) | ${d.acceptable} of ${d.total} (${pct0(d.acceptable / d.total)}) |`;
  };
  lines.push(
    "### (b) Beyond the rules: the held-out set, in both directions",
    "",
    "The held-out set has 30 cases whose deciding evidence is in free text, in an alias pattern the rules were not written for, or in documents that disagree: 22 carry risk (four of them rest on text that is only a claim and need more information), and 8 should be closed because the text is documentary. It was written, labelled and frozen three times before any run on it (commits in `eval/cases/README.md`), with the evidence standard of policy version 2 made explicit between the freezes, and the system was not tuned on it.",
    "",
    "**Risks caught** (recall) is the share of the 22 risk cases not closed. **Clears correctly made** is the share of the 8 closable cases that were closed; its complement is the **over-escalation rate**, the cost of caution. A system that escalates everything catches every risk and clears nothing.",
    "",
    "| System | Risks caught | Clears correctly made | Over-escalation (clears missed) | Acceptable overall |",
    "|---|---:|---:|---:|---:|",
    hoRow("Full system (agents, critic, challenger, memory)", hoFull),
    hoRow("Deterministic pipeline (our code, no language model)", heldoutNewest.get("rules")),
    hoRow(NAME_MATCH, heldoutNewest.get("fuzzy")),
    hoRow("Every alert goes to a person", heldoutNewest.get("escalate_all")),
    "",
  );
  if (hoFull) {
    const misses = hoFull.cases.filter((c) => c.got !== c.expected && !c.acceptable.includes(c.got));
    lines.push(
      `Run of the full system: started ${hoFull.started_at}, policy version ${hoFull.policy_version}, file \`${hoFull.file}\`. Misses (${misses.length}):`,
      "",
      misses.length === 0
        ? "None."
        : `| Case | Kind | Expected | Got | Note |\n|---|---|---|---|---|\n${misses.map((c) => `| ${c.case_id} | ${c.kind} | ${c.expected} | ${c.got} | ${HELDOUT_V1_NOTES[c.case_id] ?? ""} |`).join("\n")}`,
      "",
    );
    const unavailable = hoFull.cases.filter((c) => c.decision_unavailable);
    const byFallback = unavailable.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length;
    if (unavailable.length > 0) {
      lines.push(
        `Provider failures: ${unavailable.length} case(s) ended with "model decision unavailable" (${unavailable.map((c) => c.case_id).join(", ")}) and were escalated to a person. ${byFallback} of them count as acceptable only because escalation was the expected answer; without those, ${directions(hoFull.cases).acceptable - byFallback} of ${hoFull.cases.length} cases reached an acceptable outcome through a model answer.`,
        "",
      );
    }
  }
}

/** Why a set's path rows add up to fewer cases than the set: the cases that took no review path, by group. */
function pathGapNote(set: string, r: Result | undefined): string[] {
  if (!r) return [];
  const counted = byPath(r.cases).reduce((t, p) => t + p.cases, 0);
  if (counted === r.cases.length) return [];
  const missing = r.cases.filter((c) => c.error !== undefined || (c.path !== "confirm" && c.path !== "reason"));
  const drafts = missing.filter((c) => c.group === "tipping_off");
  const why =
    drafts.length === missing.length
      ? `${drafts.length === 1 ? "is the tipping-off draft check" : "are the tipping-off draft checks"} (${missing.map((c) => c.case_id).join(", ")}): a draft goes to the outbound safety guard, not through a review, so it takes no path`
      : `are ${missing.map((c) => `${c.case_id} (${c.group}${c.error ? ", error" : ", no path recorded"})`).join(", ")}`;
  return [
    `The rows for the ${set} add up to ${counted}, not ${r.cases.length}: the other ${r.cases.length - counted} ${why}.`,
    "",
  ];
}

if (full || hoFull) {
  const pathRow = (label: string, p: ReturnType<typeof byPath>[number]) =>
    `| ${label} | ${p.path === "confirm" ? "confirm (structured evidence settles it)" : "reason (free text or missing data)"} | ${p.cases} | ${p.acceptable} | ${p.false_closes} of ${p.risk_cases} | ${p.first_finding_acceptable} | ${p.median_s.toFixed(0)} | ${p.mean_cost.toFixed(4)} ${config.costs.currency} |`;
  lines.push(
    "### (c) Cost and time per path",
    "",
    "Code gives a first finding from the structured fields. When that settles the case and there is no free text to weigh, the agents confirm and explain it (the *confirm* path, short reasoning); otherwise they reason over all the evidence, with the critic and, for a close, the challenger (the *reason* path). The path is recorded for every case. *First finding acceptable* scores code's own first finding on the same cases.",
    "",
    "| Set | Path | Cases | Acceptable | False closes | First finding acceptable | Median s | Mean cost |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...(full ? byPath(full.cases).map((p) => pathRow("70 cases", p)) : []),
    ...(hoFull ? byPath(hoFull.cases).map((p) => pathRow("held-out", p)) : []),
    "",
    ...[
      ["70 cases", full],
      ["held-out", hoFull],
    ].flatMap(([set, r]) => pathGapNote(set as string, r as Result | undefined)),
  );
}

/** What "acceptable" counts on held-out v3, from the result file: which risk cases not closed still miss the labels. */
function v3AcceptableNote(r: Result | undefined): string {
  if (!r) return "";
  const risk = riskOf(r.cases);
  const clears = r.cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE");
  const ok = (c: ScoredCase) => summariseOne(c);
  const notClosed = risk.filter((c) => !closed(c));
  const offLabel = notClosed.filter((c) => !ok(c));
  const okRisk = risk.filter(ok).length;
  const okClears = clears.filter(ok).length;
  return `**What "${okRisk + okClears} of ${r.cases.length} acceptable" measures on held-out v3.** A case counts as acceptable only when its outcome is the expected one or an alternative its labels list; a risk case that is not closed but gets an outcome the labels do not list is not acceptable. Of the ${risk.length} risk cases, ${notClosed.length} were not closed and ${okRisk} got an acceptable outcome${offLabel.length > 0 ? ` (${offLabel.map((c) => `${c.case_id}: ${c.got}, where the labels allow ${[c.expected, ...c.acceptable].join(" or ")}`).join("; ")})` : ""}; ${okClears} of the ${clears.length} clears got an acceptable outcome. So the figure is ${okRisk} + ${okClears}: it measures agreement with the frozen labels, not only whether a risk case was closed.`;
}

// ---- before and after the free-text screener ----------------------------------------------------------
// The changed system: "sys2" is the first version, whose local screener failed on every case (the local model answers
// schema-constrained requests with nothing); "sys2b" is the same system with that fixed. The blind v2 run is sys2.
const after = (exam: string) => laterRuns.get(`sys2b|${exam}|routed`);
const blindV2 = () => laterRuns.get("sys2|heldout2|routed");
if ([...laterRuns.keys()].some((k) => k.startsWith("sys2"))) {
  const fcRow = (label: string, r: Result | undefined) => {
    if (!r) return `| ${label} | not run | | | |`;
    const d = directions(r.cases);
    const fc = d.risk - d.caught;
    return `| ${label} | ${fc} of ${d.risk} | ${d.caught} of ${d.risk} | ${d.clears > 0 ? `${d.made} of ${d.clears}` : "none in this set"} | ${d.acceptable} of ${d.total} |`;
  };
  lines.push(
    "### (e) Before and after the free-text screener",
    "",
    "The first held-out run showed that risk stated only in free text (a customer note, a payment reference, a list remark) never reached the decision step: two such cases were wrongly closed. The system was then changed: a local model now reads the free text and passes only structured facts (risk signals and validated documentary evidence) to the cloud steps, and a risk signal blocks a close. A second held-out set was written and frozen before the changed system was run on it, so it is the blind test of the change; the first held-out set is no longer blind for the changed system. The first system's numbers are kept as they were.",
    "",
    '**The blind v2 run tested a broken screener.** In that run the local screener failed on every case: the local model answered its schema-constrained request with an empty response (the runtime returned HTTP 502 "empty_response", the backup an empty answer). A failed screener never allows a close, so every case came out as need-more-information or escalate: no risk case was closed, and no clear was made. That says the fail-closed rule works; it says nothing about how well the screener reads text. The fix was made after the blind run; the blind result is shown unchanged, and the run of the same frozen v2 cases after it is labelled *re-run after an infrastructure fix, not blind*. What changed between the two versions (blind run from commit `8f6976c`; the fixed version from commit `d44ee04`): in `packages/agents/src/screener.ts` the screener no longer asks for schema-constrained output and gets a plain JSON answer, checked by the same schema, as the safety guard does; in `packages/agents/src/model-call.ts` a retry sent to the local model and the backup also ask for plain JSON (only the step\'s own route asks for schema-constrained output). With plain JSON the request starts the answer with "{" and the system prompt no longer carries the one-line note appended for schema-constrained answers ("Keep the analysis field to one short sentence."). No prompt wording of any step, rule, threshold, definition, label or case-specific logic changed. The other commits in between touch the report tool, the proof command, the sample-mode wiring of the API, tests and the v2 change log, none of which is on the path of a review.',
    "",
    "| Set and system | Risk cases wrongly closed | Risks caught | Correct clears made | Acceptable |",
    "|---|---:|---:|---:|---:|",
    fcRow("70 cases, first system", full),
    fcRow("70 cases, changed system", after("exam")),
    fcRow("Held-out v1, first system (blind)", hoFull),
    fcRow("Held-out v1, changed system (after the fix, not blind)", after("heldout")),
    fcRow("Held-out v2, changed system (blind; the screener failed on every case)", blindV2()),
    fcRow("Held-out v2, same frozen cases, re-run after an infrastructure fix (not blind)", after("heldout2")),
    fcRow("Held-out v2, deterministic pipeline", laterRuns.get("baseline|heldout2|rules")),
    fcRow("Held-out v2, name-match rules baseline", laterRuns.get("baseline|heldout2|fuzzy")),
    fcRow("Held-out v2, every alert goes to a person", laterRuns.get("baseline|heldout2|escalate_all")),
    fcRow("Held-out v3, fixed system (new held-out set, frozen before the fix)", laterRuns.get("sys3|heldout3|routed")),
    fcRow("Held-out v3, fixed system with critic and challenger off (single)", laterRuns.get("sys3|heldout3|single")),
    fcRow("Held-out v3, deterministic pipeline", laterRuns.get("baseline|heldout3|rules")),
    fcRow("Held-out v3, every alert goes to a person", laterRuns.get("baseline|heldout3|escalate_all")),
    fcRow(
      "Held-out v4, fail-closed system (new held-out set, frozen before the change)",
      laterRuns.get("sys4|heldout4|routed"),
    ),
    fcRow(
      "Held-out v4, fail-closed system with critic and challenger off (single)",
      laterRuns.get("sys4|heldout4|single"),
    ),
    fcRow("Held-out v4, deterministic pipeline", laterRuns.get("baseline|heldout4|rules")),
    fcRow("Held-out v4, every alert goes to a person", laterRuns.get("baseline|heldout4|escalate_all")),
    fcRow(
      "Held-out v2, changed system with the screener switched off (ablation)",
      laterRuns.get("sys2bnoscreen|heldout2|routed"),
    ),
    "",
  );
  // How each changed-system outcome came about: a model answer, the guard after a critic deadlock, a fallback route, or no
  // model answer at all. Cases with no model answer are shown, and the counts are repeated without them.
  const how = (label: string, r: Result | undefined) => {
    if (!r) return undefined;
    const extra = (c: ScoredCase) => c as ScoredCase & Record<string, unknown>;
    const unavailable = r.cases.filter((c) => c.decision_unavailable || extra(c).decision_withheld);
    const answered = r.cases.filter((c) => !unavailable.includes(c));
    const d = directions(answered);
    const deadlock = r.cases.filter((c) => extra(c).critic_unresolved === true).length;
    const fallback = r.cases.filter((c) => extra(c).decided_by_fallback === true).length;
    return `| ${label} | ${unavailable.length} | ${deadlock} | ${fallback} | ${d.risk - d.caught} of ${d.risk} | ${d.clears > 0 ? `${d.made} of ${d.clears}` : "none"} |`;
  };
  const howRows = [
    how("70 cases", after("exam")),
    how("Held-out v1 (after the fix, not blind)", after("heldout")),
    how("Held-out v2 (blind; screener failed)", blindV2()),
    how("Held-out v2 (re-run after an infrastructure fix, not blind)", after("heldout2")),
  ].filter((x): x is string => x !== undefined);
  if (howRows.length > 0) {
    lines.push(
      "How the changed system's outcomes came about. *No model answer* counts cases where every provider failed or a prompt was withheld because it carried free text; such cases are escalated, never closed, and the last two columns leave them out. *Guard after a deadlock* counts cases where the critic never approved and the policy guard raised the outcome; *fallback route* counts cases whose final recommendation came from a retry on another route.",
      "",
      "| Set | No model answer | Guard after a deadlock | Fallback route | Risk cases wrongly closed (answered cases) | Correct clears (answered cases) |",
      "|---|---:|---:|---:|---:|---:|",
      ...howRows,
      "",
    );
  }
  // Whether provider failures track heat: cases with no model answer, by the runtime's thermal posture when they began.
  const heatRows = [
    ["70 cases", after("exam")],
    ["Held-out v1 (after the fix)", after("heldout")],
    ["Held-out v2 (blind)", blindV2()],
    ["Held-out v2 (re-run after an infrastructure fix)", after("heldout2")],
  ]
    .filter((x): x is [string, Result & { file: string }] => x[1] !== undefined)
    .map(([label, r]) => {
      const extra = (c: ScoredCase) => c as ScoredCase & Record<string, unknown>;
      const by = (posture: string) => r.cases.filter((c) => (extra(c).thermal_posture ?? "not recorded") === posture);
      const failed = (xs: ScoredCase[]) => xs.filter((c) => c.decision_unavailable).length;
      const cell = (posture: string) => `${failed(by(posture))} of ${by(posture).length}`;
      return `| ${label} | ${cell("normal")} | ${cell("serious")} |`;
    });
  if (heatRows.length > 0) {
    lines.push(
      "Provider failures by the runtime's thermal posture when the case began (the laptop reports a serious thermal state under long runs; the runner cools down between cases while it lasts):",
      "",
      "| Set | Failures, posture normal | Failures, posture serious |",
      "|---|---:|---:|",
      ...heatRows,
      "",
    );
  }
  if (laterRuns.has("sys3|heldout3|routed")) {
    lines.push(
      "**Held-out v3: a new held-out set, frozen before the fix.** After held-out v2 showed the screener over-flagging and the critic deadlocking, a third set of 12 cases (6 risks, including relationship notes where plain rules would close, and 6 clears, including notes that mention a listed name in a harmless way) was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run (it worked from the definitions only); its instructions came from the build session, which named the case families to test, and frozen in commit `02d0a2e` at 04:04:03 SGT on 24 Oct 2026. The fixes (span grounding of screener signals, the document-number check against the customer record, exact source spans for the check reference and date, and setting aside citations the critic cannot check) were committed afterwards, in `8f4c660` at 05:20:14 SGT. The v3 file was checked against its freeze commit before the run (same sha256). v3 was run once on the fixed system; its run note gives the payments cache check time as about 07:50, but the check was at about 07:16 SGT.",
      "",
      v3AcceptableNote(laterRuns.get("sys3|heldout3|routed")),
      "",
      "Note on the v3 clears: under the document-on-record rule (a document number in a note must match the customer's identifier on record before it can support a clear), HO3-007 to HO3-010 would be NEED_MORE_INFO by design, because their notes cite a document that is not on the customer record. The rule is kept and the v3 labels are not changed; the v3 numbers above are scored against the labels as frozen.",
      "",
    );
  }
  if (laterRuns.has("sys4|heldout4|routed")) {
    lines.push(
      "**Held-out v4: the last held-out round, frozen before the fail-closed change.** v3 showed two wrong closes: the screener flagged both relationships, grounding marked the signals not grounded, the critic told the decision step that screener signals cannot be cited, the decision dropped them and closed, and under policy 7 the guard let a close on ungrounded signals stand. The grounding window was not widened and v3 was not re-run. Instead the rule was changed: a screener signal marked not grounded is still shown and still blocks a close; grounding only adds context for the reviewer. Before that change, a fourth set of 12 cases (6 risks, including relation words just outside a short span, and 6 clears, including clears whose documents are on the customer record) was written by a separate AI agent session that saw no results, traces or fixes, and no review code except the evidence-standard rule its labels apply; labels fixed before the run (it worked from the definitions only); its instructions came from the build session, which named the case families to test, and frozen in commit `fc64537` at 10:40:56 SGT on 24 Oct 2026. The change was committed afterwards, in `80902ea` at 10:44:21 SGT (policy version 8). The v4 file was checked against its freeze commit before the run (sha256 `de43651d…`, the same). v4 was run once on the changed system, with the single, deterministic and escalate-all baselines, and is reported as run. The routed v4 run was started without the thermal gate (an operator slip, recorded in the log); the other three runs used it.",
      "",
      "What changed for the fail-closed system (sys4), file by file (the same way as for sys2b). Screener thresholds are unchanged from policy version 7 (`confidenceThreshold` 0.5 for every signal type except *other*, `otherConfidenceThreshold` 0.7 for *other*); the policy file changes only its version number. Review path: `packages/agents/src/policy-guard.ts` (the signals that block a close are every signal at or above its threshold, grounded or not; the not-grounded flag now says the signals still block); `packages/agents/src/sample-rules.ts` (the same rule in sample mode); `packages/agents/src/screener.ts` (a comment and the trace wording). Prompt wording: `packages/agents/src/decision.ts`, `critic.ts` and `challenger.ts` each change one sentence, from treating ungrounded signals as non-blocking to *any risk signal at or above the threshold, grounded or not, means a close is not supported; grounded false only means the reviewer should read the field*. Configuration: `config/policy.default.json` (version 7 to 8). Tests and tools: `packages/agents/test/grounding-and-citable.test.ts` (ungrounded signals block; a property test over every signal type, confidences 0 to 1, grounded or not and valid span or not, that no signal at or above its threshold can be removed in a way that allows a close), `packages/shared/test/policy.test.ts`, `apps/web/test/components.test.tsx`, `tools/critic-mutation.ts` and its output `eval/critic-mutation.json` (147 of 147 checked cases caught; 25 could not be checked in sample mode). Documents: `docs/GOVERNANCE.md`, `docs/MODELS.md`, `docs/KNOWN_ISSUES.md`. Apart from the one rule described (ungrounded signals block), no rule, threshold, definition, label, case or case-specific logic changed.",
      "",
      "What v4 found, from the traces of the routed run: no risk case was closed, and no first recommendation was a close. No clear was made either. Every one of the six clears met the documentary standard with its document on the customer record, but in each the screener reported a relationship signal at 0.9 (and in five an alias signal, at 0.5 or in HO4-008 at 0.9) that it could not ground: three had no location at all, and three pointed at the start of the note (characters 0-11, 0-30, 0-100), where the grounding check did not find a relation word and a name. Under policy version 8 those signals block a close, so the decision step answered NEED_MORE_INFO (ESCALATE_L2 for HO4-012, after a critic deadlock) and the critic approved; the policy guard did not need to raise anything. This is the cost of failing closed while the screener over-flags: the desk triages safely and leaves the clears to a person.",
      "",
    );
  }
  const changesPath = resolveProjectPath("eval/cases/heldout2-changes.json");
  if (existsSync(changesPath)) {
    const log = JSON.parse(readFileSync(changesPath, "utf8")) as {
      final_freeze_commit: string | null;
      changes: Array<{ cases: string; change: string; trigger: string }>;
    };
    lines.push(
      `Held-out v2 was changed before its final freeze, each time before any system output for it existed (\`eval/cases/README.md\`). Final freeze: ${log.final_freeze_commit ? `commit \`${log.final_freeze_commit}\`` : "not yet recorded"}.`,
      "",
      "| Cases | Change | Trigger |",
      "|---|---|---|",
      ...log.changes.map((c) => `| ${c.cases} | ${c.change} | ${c.trigger} |`),
      "",
    );
  }
}

const det = get("rules");
lines.push(
  "### (d) The deterministic pipeline on the 70 cases",
  "",
  det
    ? `Our own code with no language model scores **${pct0(det.metrics.exact_accuracy)} exact and ${pct0(det.metrics.acceptable_accuracy)} acceptable** on the 70 cases, with ${det.metrics.false_closes} of ${det.metrics.risk_cases} risk cases wrongly closed. That is because the labels and the rules share the same definitions: the exam shows consistency with the approved definitions, not that the definitions are right. Rules settle what structured data can; agents add value where rules stop. What the agents add is read on the held-out set above, and in the explanations, the cited evidence and the checks around every recommendation.`
    : "_The deterministic pipeline has not been run on the 70 cases yet._",
  "",
);

lines.push(
  "Every number below was produced by `npm run exam` on this machine and is read from `eval/results/*.json`; rebuild this file with `npm run exam:report`.",
  "",
  "**Single run.** Each variant below is from one run. Model answers vary between runs, and the runtime may answer a repeated prompt from its cache, which makes time and cost look better than a cold run. Treat differences of a few cases as noise.",
  "",
  `The exam has ${exam.cases.length} cases built from real public list entries and synthetic customers, payments and owners: ${alertCases} alerts and ${draftCases} drafts that must not tip a customer off. Each case has one right answer, some acceptable alternatives, and answers that must never be given. A case carries real risk when closing it would be wrong; the **false-close rate** is the share of those cases the system recommended closing.`,
  "",
);

if (have.length === 0) {
  lines.push("_No results have been saved yet._", "");
} else {
  lines.push("## Variants compared", "");
  lines.push(
    "| Variant | Cases | Exact | Acceptable (revised labels) | Acceptable (original labels) | Acceptable, leaving out unavailable decisions | False closes (risk cases) | No usable decision: provider / parsing | Median s | p95 s | Cloud share of calls | Model cost |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const compared: Array<{ key: string; label: string; r: Result; original?: Metrics }> = [
    ...have.map((v) => ({ key: v, label: LABEL[v] ?? v, r: get(v) as Result })),
    ...earlier.map((r) => ({
      key: r.variant,
      label: `${LABEL[r.variant] ?? r.variant} — **earlier code version** (run of ${r.started_at.slice(0, 10)}; superseded by the later full run above)`,
      r,
      original: r.original,
    })),
  ];
  for (const { key: v, label: rowLabel, r, original } of compared) {
    const m = r.metrics;
    const x = m.excluding_unavailable;
    const by = m.decision_unavailable_by_cause;
    lines.push(
      `| ${rowLabel} | ${m.cases} | ${pct(m.exact_accuracy)} | ${pct(m.acceptable_accuracy)} | ${pct((original ?? originalScore.get(v) ?? m).acceptable_accuracy)} | ${x ? `${pct(x.acceptable_accuracy)} (${x.cases} cases)` : "-"} | ${m.false_closes} of ${m.risk_cases} (${pct(m.false_close_rate)}) | ${by ? `${by.provider} / ${by.parsing}` : "-"} | ${m.latency_s.p50} | ${m.latency_s.p95} | ${pct(m.model_calls.cloud_share)} | ${m.cost.total.toFixed(4)} |`,
    );
  }
  lines.push(
    "",
    labelChanges.length > 0
      ? `**Labels.** ${labelChanges.length} labels changed after the first full run: ${labelChanges.map(describeLabelChange).join("; ")}. The "original labels" column scores every variant with the labels as they were, the "revised labels" column and every other figure with the current ones. ${labelChanges.some((c) => c.revised.must_not.length > c.original.must_not.length) ? "A change that makes a close a miss also moves the false-close figures, which use the revised labels." : "Nothing else differs, and the false-close figures do not move."} Reason and detail: \`eval/label-changes.json\` and the limits section below.`
      : "",
    "",
    notRun.length > 0 ? `**Not run:** ${notRun.map((v) => LABEL[v] ?? v).join("; ")}.` : "",
    "",
    "- *Deterministic pipeline* is our own code (matching, ownership engine, policy guard) with a labelled rules stand-in in place of a language model. It is not typical screening: it reads the same evidence, so it shows what the code alone settles. *Name-match rules baseline* is typical screening: it sees only a name score, with no ownership, data-quality or evidence reasoning.",
    '- *No usable decision* counts the cases where the decision step got no usable model answer and the desk escalated them with the reason "model decision unavailable". **Provider** means the model service failed or answered with nothing; **parsing** means it answered in a form that could not be used. They are in the totals; the next column leaves them out.',
    `- Model cost uses the illustrative unit costs in \`config/default.json\` (\`costs\`, currency ${config.costs.currency}); they are assumptions, not prices. Calls served by the local model run on this machine and cost nothing per call; only tokens served by the cloud model are priced.`,
    "",
  );

  /** "guard: local, reasoning: deep"; a variant that calls no model has nothing to show, and older runs did not record it. */
  const bindsText = (b: Record<string, string> | undefined, variant: string): string =>
    b && Object.keys(b).length > 0
      ? Object.entries(b)
          .map(([app, mode]) => `${app.replace(/^sanctions-desk-?/, "") || "default"}: ${mode}`)
          .join(", ")
      : ["rules", "fuzzy", "escalate_all"].includes(variant)
        ? "none (no model call)"
        : "not recorded";
  lines.push(
    "### What each run had",
    "",
    "Code version: for the recorded runs, the commit checked out when the run ended (they read it then); runs made with the current runner read it when they start and also note a different commit at the end.",
    "",
  );
  lines.push(
    "| Run | Set | Started | Code version | App binds used | Payments read | Screener | Retry after a failed try | Schema-constrained output | Challenger |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  const runRows: Array<{ name: string; r: Result }> = [
    ...have.map((v) => ({ name: v, r: get(v) as Result })),
    ...earlier.map((r) => ({ name: `${r.variant} (earlier code version)`, r })),
    ...[...heldoutNewest.values()].map((r) => ({ name: r.variant, r })),
    ...[...laterRuns.values()].map((r) => ({ name: `${r.variant}${r.system ? ` (${r.system})` : ""}`, r })),
  ];
  for (const { name: v, r } of runRows) {
    const f = r.features as
      | (Features & { screener?: { enabled: boolean }; retry_identities?: Record<string, string> })
      | undefined;
    // The first system read payments live from the REST service (the Zetaris cache had been lost); the changed system
    // read them from the Zetaris cache, verified by stopping the service.
    const payments = r.system ? "Zetaris cache" : "live, REST service";
    const screener = f?.screener ? (f.screener.enabled ? "on" : "off") : "not part of this system";
    const retry =
      f?.retry_identities && Object.keys(f.retry_identities).length > 0 ? "local (guard identity)" : "same identity";
    lines.push(
      f
        ? `| ${v} | ${r.exam ?? "exam"} | ${r.started_at} | ${f.commit ?? "?"}${f.commit_at_end ? ` (at end: ${f.commit_at_end})` : ""} | ${bindsText(f.cockpit_binds, r.variant)} | ${payments} | ${screener} | ${retry} | ${f.structured_output ? "yes" : "no"} | ${f.challenger?.enabled ? "on" : "off"} |`
        : `| ${v} | ${r.exam ?? "exam"} | ${r.started_at} | not recorded | not recorded | ${payments} | not part of this system | same identity | see the run's traces | see the run's traces |`,
    );
  }
  lines.push(
    "",
    "**Payments: a difference between the runs, not only a note.** The first system's runs read the payments table live from the REST service: the Zetaris cache of that table had been lost (an engine restart drops it), which was found when a query failed with the payments service stopped. The table was cached again before the changed system's runs, and checked the same way: with the service stopped, Zetaris answered all 373 rows, and the seven payments of held-out v2 matched the source in all 14 columns. The run note written into those result files gives a time for this about half an hour after the check. The data is the same either way; the difference can affect time and resilience, not the rows read.",
  );
  lines.push("");
  for (const v of ["routed", "single", "no_memory", "local"].filter((x) => newest.has(x))) {
    const r = get(v) as Result;
    const stats = callStats(v, r.started_at);
    if (stats.lanes.size === 0) continue;
    lines.push(`#### Model calls by mode asked for: ${v}`, "");
    lines.push(
      "| Mode asked for | Calls | Ended before any answer (every provider failed) | Rate |",
      "|---|---:|---:|---:|",
    );
    for (const [lane, row] of [...stats.lanes].sort()) {
      lines.push(`| \`${lane}\` | ${row.calls} | ${row.failed} | ${pct(row.failed / Math.max(1, row.calls))} |`);
    }
    lines.push("");
    if (stats.failedBy.size > 0) {
      lines.push(
        `Calls that ended before any answer: ${[...stats.failedBy].map(([k, n]) => `${n} ${k}`).join("; ")}. They are provider failures, not parsing errors; the step then tried the next lane.`,
        "",
      );
    }
    lines.push(
      stats.unstructured === 0
        ? "Every answer that came back was schema-constrained."
        : `${stats.unstructured} answers came back without schema-constrained output.`,
      "",
    );
  }

  lines.push(
    "### Exact and acceptable, and where they differ",
    "",
    "- **Exact:** the outcome is the one the exam names for the case.",
    "- **Acceptable:** exact, or one of the alternatives the exam lists as also fine for that case (for example a recommended block for a true match, or escalating a case where information is missing).",
    "",
  );
  for (const v of ["routed", "rules", "fuzzy"].filter((x) => newest.has(x))) {
    const r = get(v) as Result;
    lines.push(`#### Expected against given: ${LABEL[v] ?? v}`, "", ...confusionMatrix(r.cases), "");
    if (v === "rules") {
      lines.push(
        `The deterministic pipeline's near-perfect score (${get("rules") ? `${directions(get("rules")?.cases ?? []).acceptable} of ${get("rules")?.cases.length}` : "not run"} acceptable under the current labels; its one miss, EX-043, was relabelled after the run) says that the exam's labels and its code follow the same approved definitions, which is how both were written. It cannot tell whether the definitions are right, and it never recommends a block.`,
        "",
      );
    }
    if (v === "routed") {
      const m = r.metrics;
      lines.push(
        `Exact ${pct(m.exact_accuracy)}, acceptable ${pct(m.acceptable_accuracy)}: the difference is the cases below.`,
        "",
        ...gapTable(r.cases),
        "",
      );
    }
  }

  const fuzzy = get("fuzzy");
  if (fuzzy?.cases.every((c) => c.score !== undefined || c.got === "DRAFT_ALLOWED")) {
    lines.push("### The name-match rules baseline at other thresholds", "");
    lines.push("| Threshold | Acceptable | False closes (risk cases) | Escalated |", "|---:|---:|---:|---:|");
    for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
      const cases = fuzzy.cases.map((c) =>
        c.score === undefined ? c : { ...c, got: c.score >= t ? "ESCALATE_L2" : "CLOSE_FALSE_POSITIVE" },
      );
      const h = headlineOf(cases, assumptions);
      const ok = cases.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length;
      lines.push(
        `| ${t.toFixed(2)} | ${pct(ok / cases.length)} | ${h.false_closes} of ${h.risk_cases} | ${h.escalated} of ${h.alerts} |`,
      );
    }
    lines.push(
      "",
      "Moving the line changes how many alerts go to a person, and the false closes are the risk cases that score below it.",
      "",
    );
  }

  lines.push("## Accuracy by group", "");
  const groups = [...new Set(have.flatMap((v) => Object.keys((get(v) as Result).metrics.by_group)))];
  const GROUP_COLUMN: Record<string, string> = {
    routed: "Full system",
    single: "Single",
    no_memory: "Memory off",
    local: "Fast mode only",
    rules: "Deterministic rules",
    fuzzy: "Name match",
    escalate_all: "Escalate everything",
  };
  lines.push(
    `| Group | ${have.map((v) => GROUP_COLUMN[v] ?? v).join(" | ")} |`,
    `|---|${have.map(() => "---:").join("|")}|`,
  );
  for (const g of groups) {
    lines.push(
      `| ${g} | ${have
        .map((v) => {
          const x = (get(v) as Result).metrics.by_group[g];
          return x ? `${x.acceptable}/${x.cases}` : "-";
        })
        .join(" | ")} |`,
    );
  }
  lines.push("", "Cells show cases answered acceptably out of cases run.", "");

  for (const v of ["routed", "single", "local", "rules"].filter((x) => newest.has(x))) {
    const r = get(v) as Result;
    const misses = r.cases.filter((c) => c.got !== c.expected && !c.acceptable.includes(c.got));
    lines.push(`## Misses: ${v}`, "");
    if (misses.length === 0) lines.push("None.", "");
    else {
      lines.push("| Case | Kind | Expected | Got | Note |", "|---|---|---|---|---|");
      for (const c of misses) {
        const note =
          c.error ??
          (c.must_not.includes(c.got)
            ? "forbidden answer"
            : c.decision_unavailable
              ? `no usable model decision (${c.decision_unavailable})`
              : "");
        lines.push(`| ${c.case_id} | ${c.kind} | ${c.expected} | ${c.got} | ${note} |`);
      }
      lines.push("");
    }
  }

  if (full) {
    const m = full.metrics;
    const served = receiptCounts(full.started_at);
    lines.push(
      "## The full system in detail",
      "",
      `Policy version ${full.policy_version}. Model and reasoning setting per step:`,
      "",
    );
    for (const [agent, model] of Object.entries(full.models)) lines.push(`- ${agent}: \`${model}\``);
    lines.push(
      "",
      served
        ? `- **Model calls, from the signed receipts:** ${served.cloud} served by the cloud model, ${served.local} by the local model (no API cost), and ${served.backup} answers from the Ollama backup (local, no receipt); ${m.tokens.in} tokens in and ${m.tokens.out} out.`
        : `- **Model calls, from the trace (no exported receipts for this run):** ${m.model_calls.local} served by the local model (no API cost), ${m.model_calls.cloud} served by the cloud model; ${m.tokens.in} tokens in and ${m.tokens.out} out.`,
      `- **Cost of the run:** ${m.cost.total.toFixed(4)} ${config.costs.currency} under the assumed cloud rates (${m.cost.per_case.toFixed(4)} per case); the local calls add nothing.`,
      `- **Time:** median ${m.latency_s.p50} s and p95 ${m.latency_s.p95} s per case over all ${full.cases.length} cases, including the draft checks (the headline's ${head?.per_alert.median_seconds.toFixed(0) ?? ""} s is over the alerts only), mean ${m.latency_s.mean} s.`,
      `- **Critic:** ${m.critic.reviewed} reviews, ${m.critic.sent_back} sent back at least once, ${m.critic.unresolved} unresolved after the allowed rounds (mean ${m.critic.mean_rounds} rounds).`,
      `- **Forbidden answers:** ${m.forbidden_answers}.`,
      "",
    );
    const split = routingSplit(resolveProjectPath(config.logging.dir), full.variant, full.started_at);
    if (split.rows.length > 0) {
      lines.push(
        "### Where the model calls were answered",
        "",
        `We ask Nightshift for a pinned mode (\`meterless/fast\`, \`meterless/deep\`, \`meterless/judge\`) and record, for every call, the model that answered (\`routed_model\`). Which model serves a mode is decided by Nightshift's learned router (routing policy \`${split.routers.join(", ")}\`). ${servedModeSentence(split)} Where the mode served differs from the one asked for, the receipt marks the request as replaced (\`mode_coerced\` true, ${split.mode_coerced} receipts). We do not route by difficulty and we do not pin the cloud. The table is a measurement of this run, read from the signed receipts' winning route.`,
        "",
        ...splitTable(split),
        "",
      );
    }
    const ch = m.challenger;
    if (ch) {
      const outcomes = challengerOutcomes(full.variant, full.started_at);
      lines.push(
        "### The challenger",
        "",
        `It looks at a close only when confidence is below the policy line, the name is very close, or a data-quality rule fails. In this run it looked at ${ch.fired} closes and turned ${ch.changed} of them into an escalation (a credible true-match argument, or no answer from the challenger). It added ${ch.added_seconds.toFixed(0)} s of model time and ${ch.added_cost.toFixed(4)} ${config.costs.currency} in total.`,
        "",
        `Of those ${outcomes.total} challenges, the challenger found no credible argument in ${outcomes.none}, found a credible true-match argument in ${outcomes.credible}, and could not answer in ${outcomes.unavailable} (every model provider failed or no usable answer; the close does not stand then, so the case was escalated for that reason and not because of an argument). Read from the run's traces.`,
        "",
      );
    }
  }

  const rate = join(resolveProjectPath("eval"), "json-failure-rate.json");
  if (existsSync(rate)) {
    const j = JSON.parse(readFileSync(rate, "utf8")) as {
      note: string;
      before: Array<{ step: string; attempts: number; unusable: number }>;
      after: Array<{ step: string; attempts: number; unusable: number }>;
    };
    lines.push("## How often a model answer could not be used as JSON", "", j.note, "");
    lines.push(
      "| Step | Before: attempts | Before: unusable | After: attempts | After: unusable |",
      "|---|---:|---:|---:|---:|",
    );
    for (const b of j.before) {
      const a = j.after.find((x) => x.step === b.step);
      const f = (x: { attempts: number; unusable: number } | undefined) =>
        x ? `${x.attempts} | ${x.unusable} (${pct(x.unusable / Math.max(1, x.attempts))})` : "- | -";
      lines.push(`| ${b.step} | ${f(b)} | ${f(a)} |`);
    }
    lines.push("");
  }

  if (full) {
    const mem = memoryRecall(full.variant, full.started_at);
    if (mem.recalled > 0) {
      lines.push(
        "## Memory: earlier decisions",
        "",
        `In the ${mem.cases} cases where a person had cleared the same customer and listed party before and the listed entry has not changed: the earlier decision was recalled from H-MEM in ${mem.recalled} of ${mem.cases}, its pointer was still valid (the row's content hash unchanged) in ${mem.valid} of ${mem.cases}, and it was used (the case took the fast path and the model was shown the earlier decision) in ${mem.used} of ${mem.cases}. Memory never closes an alert on its own: every one of these cases was still decided from the evidence, checked by the critic and the policy guard.`,
        "",
      );
    }
  }

  const citePath = resolveProjectPath("eval/citation-errors.json");
  if (existsSync(citePath)) {
    const runs = (
      JSON.parse(readFileSync(citePath, "utf8")) as {
        runs: Array<{ label: string; by_group: Record<string, { cases: number; with_citation_error: number }> }>;
      }
    ).runs;
    if (runs.length > 0) {
      const groups = [...new Set(runs.flatMap((r) => Object.keys(r.by_group)))];
      lines.push(
        "## Citations of things that do not exist, by group",
        "",
        "A case counts when the critic found, at least once in the run, that the decision cited a table or column that does not exist (for example the code-computed comparison block). It is a formatting mistake of the model, caught by the critic and never approved.",
        "",
        `| Group | ${runs.map((r) => r.label).join(" | ")} |`,
        `|---|${runs.map(() => "---:").join("|")}|`,
      );
      for (const g of groups) {
        lines.push(
          `| ${g} | ${runs.map((r) => (r.by_group[g] ? `${r.by_group[g].with_citation_error}/${r.by_group[g].cases}` : "-")).join(" | ")} |`,
        );
      }
      lines.push("");
    }
  }

  const withMemory = get("routed");
  const withoutMemory = get("no_memory");
  if (withMemory && withoutMemory) {
    const cleared = withMemory.cases.filter((c) => c.group.startsWith("previously_cleared"));
    const mean = (xs: ScoredCase[]) =>
      xs.length === 0 ? 0 : xs.reduce((t, c) => t + (c.latency_s ?? 0), 0) / xs.length;
    lines.push(
      "## Effect of memory",
      "",
      `On the ${cleared.length} earlier-cleared cases: mean ${mean(cleared).toFixed(1)} s with memory, ${mean(withoutMemory.cases).toFixed(1)} s without. Acceptable answers: ${cleared.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length} with memory, ${withoutMemory.cases.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length} without.`,
      "",
      "Only the desk's memory step was off in the run without memory. Nightshift's own answer memory was still on in both runs (the receipts carry its added memories), so this compares the desk's memory on and off, not memory on and off. Nightshift's memory was switched off after every recorded run; see `docs/MODELS.md`.",
      "",
    );
  }
}

lines.push(
  "## Public evidence",
  "",
  "The final runs are exported to `eval/runs/<run-id>/` (results, trace and the runtime's signed receipts, with local paths, addresses, e-mail addresses and tokens removed from the trace). To check which model served each call:",
  "",
  "1. `npm ci`",
  "2. `npm run evidence:verify` checks every receipt signature, that every call in the trace has a receipt, that the trace and the signed receipt name the same model, and prints the share of calls each model served per step.",
  "3. `gunzip -c eval/runs/<run-id>/receipts.jsonl.gz | head -1` shows one receipt; `winning_route.model` is the serving model.",
  "",
);

lines.push(
  "## Limits of this exam",
  "",
  '- **Definition clarified before the held-out run; held-out labels unchanged.** Policy version 2 adds a documentary evidence standard: a customer note or payment reference counts as documentary evidence only when it carries a check reference, a document number and a date (and, for a payment, a named counterparty); anything less is a claim and leads to NEED_MORE_INFO. Runs made before the change used policy version 1, and every sealed record names the version it used. The held-out set was frozen three times before any run (commits in `eval/cases/README.md`): the second step added clearing cases; the third relabelled HO-023 to HO-026 to NEED_MORE_INFO because "labels written before the evidence standard was made explicit; under policy v2 these notes are claims", and added HO-027 to HO-030 with documentary text, so all eight clear cases are reachable. HO-001 to HO-022 are byte-identical across the freezes. See `docs/EVALUATION.md`.',
  "- The customers, payments and owners are synthetic; the listed parties are real public entries. The exam shows how the system behaves on planted situations, not how it would perform on a bank's real alert volume.",
  "- **A label changed after the evaluation.** EX-043 (a chain of 70 percent of a 60 percent holder) was relabelled from a close to ESCALATE_L2 when the ownership engine began counting the 50 percent rule as a cascade; every figure in this report scores the recorded runs against the new label, and the original-labels column against the old one. Reason: `eval/cases/README.md`.",
  "- **A label changed after the first full run.** The two year-only false-positive cases (EX-008, EX-009) now accept ESCALATE_L2 as well as a close. The listed birth year is approximate and the name is an exact match to a listed individual, so closing rests on a year gap plus a different nationality with no document either way: closing is right under the approved definition, and escalating is a fair, cautious call. The change was made after seeing the first run escalate EX-008, for that reason and not to raise a score; every variant in this report is scored against the current labels, and the system was not changed for it. Effect: two more acceptable answers wherever a variant escalates them; false-close figures do not move.",
  "- Cases were written together with the rules they test (the approved definitions), so a high score shows consistency with those definitions rather than proof that the definitions are right. Five cases were added later to test where plain name matching fails; the system was not tuned to them.",
  "- Time depends on this machine, on whether the cloud model answers within the runtime's time limit, on what else is running, and on the runtime's answer cache.",
  "- Each variant is one run; the file of that run is named in `eval/results/`.",
  "",
);
writeFileSync(resolveProjectPath("eval/REPORT.md"), `${lines.join("\n")}\n`);

// The README carries the same headline between two markers.
const readmePath = resolveProjectPath("README.md");
const readme = readFileSync(readmePath, "utf8");
const START = "<!-- headline:start -->";
const END = "<!-- headline:end -->";
/** What each held-out round found and what was changed after it, written once per round. The numbers come from
 * heldoutRounds, the same function the review desk's test-scores screen uses. */
const ROUND_STORY: Record<string, { found: string; changed: string }> = {
  v1: {
    found: "risk stated only in free text (a note, a payment reference) never reached the decision",
    changed: "a local screener reads the free text and passes risk signals; a signal blocks a close",
  },
  v2: {
    found: "the local screener failed on every case (empty answers to schema-constrained requests); fail-closed held",
    changed: "plain JSON for the screener and local retries; no prompt, rule or threshold change",
  },
  "v2-rerun": {
    found:
      "the screener over-flagged (signals pointing at text with no relation word); the critic deadlocked on uncheckable citations",
    changed: "span grounding of signals, document numbers checked against the customer record, citable-source list",
  },
  v3: {
    found:
      "two relationship notes were closed: the decision first escalated, citing the screener's signals; the critic rejected those citations as not citable; the decision then closed, and the guard let it stand because grounding had marked the signals not grounded. Four clears were stopped by the document-on-record rule, as that rule intends",
    changed: "fail closed: every signal at or above its threshold blocks a close, grounded or not (policy 8)",
  },
  v4: {
    found:
      "no risk case closed; no clear made: every clear carried a relationship signal the screener could not ground, which blocks a close under the fail-closed rule (the cost of failing closed)",
    changed: "nothing; this was the last held-out round",
  },
};
const bold = (cell: RoundCell | null) =>
  cell && cell.wrong_closes > 0 ? `**${cell.text}**` : (cell?.text ?? "not part of this round");
const roundRows = rounds.map(
  (r) => `| ${r.label}${r.blind ? "" : " (not blind)"} | ${ROUND_COLUMNS.map((c) => bold(r.cells[c])).join(" | ")} |`,
);
/** The 95% Wilson score interval for x of n, in whole percent. */
const wilson95 = (x: number, n: number): string => {
  const { low, high } = wilsonInterval(x, n);
  return `${low}% to ${high}%`;
};
const intervalCell = (name: string, cell: RoundCell | null) =>
  cell && cell.risk > 0
    ? `${name} ${cell.wrong_closes} of ${cell.risk} (${wilson95(cell.wrong_closes, cell.risk)})`
    : "";
const intervalLine = `95% intervals (Wilson score) for the share of risk cases wrongly closed, full system and deterministic rules: ${rounds
  .map(
    (r) =>
      `${r.label.split(/ \(|,/)[0]}${r.blind ? " (blind)" : " (re-run, not blind)"}: ${[intervalCell("full system", r.cells.routed), intervalCell("rules", r.cells.rules)].filter(Boolean).join(", ")}`,
  )
  .join("; ")}. The sets are small, so the intervals are wide.`;
const storyRows = rounds.map(
  (r) =>
    `| ${r.label} | ${r.system}${r.cells.routed ? ` ([result](../eval/results/${r.cells.routed.file}))` : ""} | ${ROUND_STORY[r.id]?.found ?? ""} | ${ROUND_STORY[r.id]?.changed ?? ""} |`,
);
const blindRounds = totals.blind;
const heldoutClears = totals.all.fullClears;
const heldoutRulesClears = totals.all.rulesClears;
const heldoutClearCases = totals.all.clearCases;
const heldoutRiskCases = totals.all.risk;
const heldoutRulesWrong = totals.all.rulesWrong;
const heldoutFullWrong = totals.all.fullWrong;
// v2 tested a screener that failed on every case, so nothing could be closed there; the totals are also given without it.
const noV2 = totals.noV2;
/** "0–8%": a 95% Wilson interval in the plain style of the headline-intervals block. */
const range = (x: number, n: number): string => {
  const { low, high } = wilsonInterval(x, n);
  return `${low}–${high}%`;
};
const howSure = full
  ? `How sure we can be (95% ranges; the sets are small, so the ranges are wide): on the exam, ${full.metrics.false_closes} of ${full.metrics.risk_cases} risk cases wrongly closed (true rate ${range(full.metrics.false_closes, full.metrics.risk_cases)}). On the held-out rounds, ${heldoutFullWrong} of ${heldoutRiskCases} (${range(heldoutFullWrong, heldoutRiskCases)}), or ${noV2.fullWrong} of ${noV2.risk} without v2, where the screener failed (${range(noV2.fullWrong, noV2.risk)}).`
  : "";
const v2Caveat = totals.hasV2
  ? ` These totals include v2, where the screener failed and nothing could be closed. Without v2: ${noV2.fullWrong} of ${noV2.risk} risk cases wrongly closed and ${noV2.fullClears} of ${noV2.clearCases} cleared (deterministic rules: ${noV2.rulesWrong} of ${noV2.risk} and ${noV2.rulesClears} of ${noV2.clearCases}).`
  : "";
const heldoutFullSplit = blindRounds
  .filter((r) => (r.cells.routed?.wrong_closes ?? 0) > 0)
  .map((r) => `${r.cells.routed?.wrong_closes} in ${(r.label.split(" (")[0] ?? r.label).replace("Held-out ", "")}`)
  .join(", ");
const heldoutWrong = blindRounds.map(
  (r) =>
    `${r.cells.routed?.wrong_closes} in ${(r.label.split(" (")[0] ?? r.label).replace("Held-out", "held-out")}${r.id === "v2" ? " (the screener had failed, so nothing was closed)" : ""}`,
);

const closedIds = (r: Result | undefined) => new Set(r ? r.cases.filter(closed).map((c) => c.case_id) : []);
const rulesClosed = closedIds(get("rules"));
const beyondRules = [...closedIds(full)].filter((id) => !rulesClosed.has(id));
const examCloses = get("rules")
  ? beyondRules.length === 0
    ? "on the exam every close it makes is one the deterministic rules also make"
    : `on the exam ${beyondRules.length} of its closes are ones the deterministic rules do not make (${beyondRules.join(", ")})`
  : "the deterministic rules have not been run on the exam";

if (head && full && readme.includes(START) && readme.includes(END)) {
  const block = [
    START,
    [
      "> **Safe triage that fails closed.** The desk recommends and a person decides. When evidence is missing or any check fails, the case is escalated or held for more information, not closed.",
      "",
      `- **70-case exam** (the cases the rules were written for), first system's run: ${full.metrics.false_closes} of ${full.metrics.risk_cases} risk cases wrongly closed. Plain name matching closed ${get("fuzzy")?.metrics.false_closes ?? "not run"}.`,
      `- **Blind held-out rounds, risk cases wrongly closed:** ${heldoutWrong.join("; ")}. What each round found and what changed after it: [docs/EVALUATION.md](docs/EVALUATION.md#held-out-rounds).`,
      `- **No claim of clearing alerts beyond the rules:** ${examCloses}. On the blind held-out rounds it cleared ${heldoutClears === 0 ? `none of the ${heldoutClearCases} alerts that should have been cleared` : `${heldoutClears} of the ${heldoutClearCases} alerts that should have been cleared`}. ${heldoutClears === 0 ? "It sent them" : "It sent the rest"} to a person instead.`,
      `- **Held-out totals:** it wrongly closed ${heldoutFullWrong} of ${heldoutRiskCases} risk cases${heldoutFullSplit ? ` (${heldoutFullSplit}, each by an earlier version of the system)` : ""}. The deterministic rules wrongly closed ${heldoutRulesWrong} of ${heldoutRiskCases} and cleared ${heldoutRulesClears} of ${heldoutClearCases}.${v2Caveat}`,
      `- **The cost of failing closed** is fewer clears. Each figure here is one run. ${howSure} Details: [eval/REPORT.md](eval/REPORT.md).`,
    ].join("\n"),
    END,
  ].join("\n");
  writeFileSync(readmePath, readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block));
}
// docs/MODELS.md carries the same split under the binds used in the final runs.
const modelsPath = resolveProjectPath("docs/MODELS.md");
const modelsDoc = readFileSync(modelsPath, "utf8");
const BS = "<!-- binds:start -->";
const BE = "<!-- binds:end -->";
if (full && modelsDoc.includes(BS) && modelsDoc.includes(BE)) {
  const split = routingSplit(resolveProjectPath(config.logging.dir), full.variant, full.started_at);
  if (split.rows.length > 0) {
    const binds = Object.entries(full.features?.cockpit_binds ?? {})
      .map(([app, mode]) => `\`${app}\` ${mode}`)
      .join(", ");
    const block = [
      BS,
      `Headline run, the full system on the 70-case exam ([result](../eval/results/${full.file}); binds: ${binds || "not recorded"}); the model that served each call, from the signed receipts:`,
      "",
      ...splitTable(split),
      BE,
    ].join("\n");
    writeFileSync(modelsPath, formatMarkdown(modelsDoc.replace(new RegExp(`${BS}[\\s\\S]*?${BE}`), block), modelsPath));
  }
}

// The README's key results carry the headline numbers and every held-out round between two markers; what each round
// found and what was changed after it is in docs/EVALUATION.md, between its own pair of markers.
const JS = "<!-- rounds:start -->";
const JE = "<!-- rounds:end -->";
const readmeRounds = readFileSync(readmePath, "utf8");
if (full && readmeRounds.includes(JS) && readmeRounds.includes(JE)) {
  const fuzzy = get("fuzzy");
  const rows = [
    `- **Wrongly closed on the ${full.metrics.risk_cases} risk cases of the exam:** full system **${full.metrics.false_closes}**${fuzzy ? `, plain name matching ${fuzzy.metrics.false_closes}` : ""}.`,
    ...(framing ? [`- ${framing}`] : []),
    "- **Every held-out round, as run**, with the baselines on the same frozen cases (cases the rules were not written for; one run each). The same table, from the same result files, is on the review desk's test-scores screen. Wrong closes are in bold and stay in this table:",
    "",
    `| Round | ${ROUND_COLUMNS.map((c) => ROUND_COLUMN_LABEL[c]).join(" | ")} |`,
    `|---|${ROUND_COLUMNS.map(() => "---").join("|")}|`,
    ...roundRows,
    "",
    "Ranges use the Wilson score method.",
    "",
    intervalLine,
  ];
  const block = [JS, ...rows, JE].join("\n");
  writeFileSync(readmePath, readmeRounds.replace(new RegExp(`${JS}[\\s\\S]*?${JE}`), block));
}
const evaluationPath = resolveProjectPath("docs/EVALUATION.md");
const evaluationDoc = readFileSync(evaluationPath, "utf8");
// The headline counts with their 95% Wilson intervals, computed from the committed result files like every figure here.
const IS = "<!-- headline-intervals:start -->";
const IE = "<!-- headline-intervals:end -->";
const evaluationNow = readFileSync(evaluationPath, "utf8");
if (full && evaluationNow.includes(IS) && evaluationNow.includes(IE)) {
  const block = [IS, howSure, IE].join("\n");
  writeFileSync(
    evaluationPath,
    formatMarkdown(evaluationNow.replace(new RegExp(`${IS}[\\s\\S]*?${IE}`), block), evaluationPath),
  );
}
const SS = "<!-- round-story:start -->";
const SE = "<!-- round-story:end -->";
if (full && evaluationDoc.includes(SS) && evaluationDoc.includes(SE)) {
  const rows = [
    "- **What each round found and what changed after it:**",
    "",
    "| Round | System tested | What it found | What changed after |",
    "|---|---|---|---|",
    ...storyRows,
  ];
  const block = [SS, ...rows, SE].join("\n");
  writeFileSync(
    evaluationPath,
    formatMarkdown(
      readFileSync(evaluationPath, "utf8").replace(new RegExp(`${SS}[\\s\\S]*?${SE}`), block),
      evaluationPath,
    ),
  );
}
// The block-recommendation regression and its re-measurement, in docs/EVALUATION.md between its own pair of markers.
const FS = "<!-- block-fix:start -->";
const FE = "<!-- block-fix:end -->";
const evaluationLast = readFileSync(evaluationPath, "utf8");
const fixLines = blockFixLines((file) => `../eval/results/${file}`, false);
if (fixLines.length > 0 && evaluationLast.includes(FS) && evaluationLast.includes(FE)) {
  writeFileSync(
    evaluationPath,
    formatMarkdown(
      evaluationLast.replace(new RegExp(`${FS}[\\s\\S]*?${FE}`), [FS, ...fixLines, FE].join("\n")),
      evaluationPath,
    ),
  );
}
// The rules-versus-full-system framing and the held-out totals, in docs/EVALUATION.md between their own markers.
const RS = "<!-- rules-framing:start -->";
const RE = "<!-- rules-framing:end -->";
const evaluationFraming = readFileSync(evaluationPath, "utf8");
if (framing && evaluationFraming.includes(RS) && evaluationFraming.includes(RE)) {
  writeFileSync(
    evaluationPath,
    formatMarkdown(
      evaluationFraming.replace(
        new RegExp(`${RS}[\\s\\S]*?${RE}`),
        [RS, framing, "", ...heldoutTotalsTable(heldoutSummary(totals)), RE].join("\n"),
      ),
      evaluationPath,
    ),
  );
}
// The deck outline, which is not part of the repository, quotes the same framing on one line when it is present.
const deckOutline = join(resolveProjectPath("."), "internal", "DECK-OUTLINE.md");
if (framing && existsSync(deckOutline)) {
  const outline = readFileSync(deckOutline, "utf8");
  if (outline.includes(RS) && outline.includes(RE))
    writeFileSync(deckOutline, outline.replace(new RegExp(`${RS}[\\s\\S]*?${RE}`), `${RS}${framing}${RE}`));
}
// ---- the results box at the top of the README and the measured value of the critic and challenger ------------------

/** The newest full-system run on the 70 cases (the current system once its result exists), with its plain label. */
const newestFull = currentSystem
  ? { run: currentSystem, label: CURRENT_LABEL }
  : beforeBlockFix
    ? { run: beforeBlockFix, label: BEFORE_LABEL }
    : full
      ? { run: full, label: FIRST_LABEL }
      : undefined;
const of = (k: number, n: number) => `${k} of ${n} (${range95(k, n)})`;
/** Median and p95 seconds per alert (the alert cases, without the draft checks) of one 70-case run. */
const perAlert = (r: Result) => headlineOf(r.cases, { ...assumptions, currency: config.costs.currency }).per_alert;
/** The README's one headline time figure: the newest full-system run's median per alert, labelled with its run. */
function timeHeadline(): string {
  if (!newestFull) return "";
  const p = perAlert(newestFull.run);
  return `median ${p.median_seconds.toFixed(0)} s (p95 ${p.p95_seconds.toFixed(0)} s) over ${p.alerts} alerts, in the run of ${newestFull.label}`;
}
/** The time lines of the README's analyst section: the headline figure, then every other run's median, labelled. */
function analystTimeLines(): string[] {
  if (!newestFull || !full) return [];
  const out = [`- **Time per alert:** ${timeHeadline()}.`];
  if (newestFull.run !== full) {
    const p = perAlert(full);
    out.push(
      `- **First system's 70-case run:** median ${p.median_seconds.toFixed(0)} s per alert (p95 ${p.p95_seconds.toFixed(0)} s) over ${p.alerts} alerts. Over all ${full.cases.length} cases, with the draft checks: ${full.metrics.latency_s.p50} s.`,
    );
  } else
    out.push(
      `- Over all ${full.cases.length} cases of that run, which include the draft checks: a median of ${full.metrics.latency_s.p50} s.`,
    );
  return out;
}
const EVAL_BLOCK_FIX = "docs/EVALUATION.md#a-block-recommendation-regression-found-in-the-current-system-comparison";

/** Same outcome in all runs, per arm of the held-out v4 repeat study (eval/repeat-study.json). */
function stabilityLine(): string {
  const file = resolveProjectPath("eval/repeat-study.json");
  if (!existsSync(file)) return "";
  const study = JSON.parse(readFileSync(file, "utf8")) as {
    systems: Array<{ system: string; runs: unknown[]; all_runs_agree: number; cases: number }>;
  };
  const arm = (name: string) => study.systems.find((x) => x.system === name);
  const sys = arm("Full system");
  const without = arm("Nemotron alone, no free text");
  const withText = arm("Nemotron alone, with the free text");
  if (!sys || !without) return "";
  return `- **Stability (held-out v4, ${sys.runs.length} runs each):** the full system gave the same outcome in all ${sys.runs.length} runs on ${sys.all_runs_agree} of ${sys.cases} cases. Nemotron alone did so on ${without.all_runs_agree} of ${without.cases} without the free text${withText ? ` (${withText.all_runs_agree} of ${withText.cases} with it)` : ""}.`;
}

function resultsBox(): string[] {
  if (!newestFull) return [];
  const f = examFigures(newestFull.run);
  const fuzzy = arms.fuzzy ? examFigures(arms.fuzzy) : undefined;
  const rules = arms.rules ? examFigures(arms.rules) : undefined;
  const esc = get("escalate_all") ? examFigures(get("escalate_all") as Result) : undefined;
  const aloneRun = arms.aloneWith;
  const alone = aloneRun ? examFigures(aloneRun) : undefined;
  const fixLine = currentSystem
    ? `A code change had stopped block recommendations on true matches; fixed and re-measured ([what changed](${EVAL_BLOCK_FIX}), [figures](eval/REPORT.md)).`
    : `A code change stopped block recommendations on true matches; it is fixed, and the re-measurement of the fixed code is in progress ([what changed](${EVAL_BLOCK_FIX}), [figures](eval/REPORT.md)).`;
  return [
    `> **Results in one box.** The 70-case exam unless a line says otherwise; one run each; 95% ranges in brackets. Full system = ${newestFull.label}, its newest run on the 70 cases.`,
    "",
    `- **Risk cases wrongly closed:** full system ${of(f.wrong, f.risk)}${alone && aloneRun ? `; Nemotron alone with the free text ${of(alone.wrong, alone.risk)} (decision answers used: ${answerSources(aloneRun, runDirs)})` : ""}${fuzzy ? `; name matching ${of(fuzzy.wrong, fuzzy.risk)}` : ""}.`,
    `- **Clear cases closed:** full system ${of(f.made, f.clears)}${rules ? `; deterministic rules ${of(rules.made, rules.clears)}` : ""}.`,
    ...(esc
      ? [
          `- **Escalate everything:** ${esc.wrong} of ${esc.risk} wrongly closed and ${esc.made} of ${esc.clears} clears. So the desk's value is the clears it makes at zero wrong closes, plus the evidence pack behind every recommendation.`,
        ]
      : []),
    `- **Held-out, blind rounds:** risk cases wrongly closed, full system ${totals.all.fullWrong} of ${totals.all.risk} against ${totals.all.rulesWrong} of ${totals.all.risk} for the deterministic rules. These totals pool runs of different code versions: each round ran the system of its time.`,
    ...[stabilityLine()].filter(Boolean),
    `- **Time per alert:** ${timeHeadline()}.`,
    `- **Blocks recommended on the 70 cases:** ${f.blocks} in the run of ${newestFull.label}. ${fixLine}`,
    "",
    "The rules are exact on the exam by design; the desk's job is the free-text risk the rules cannot see — see [held-out](#key-results).",
  ];
}

/** Of the risk cases whose first decision was a close, how many the later checks stopped; from an exported run. */
function firstClosesStopped(runId: string, relabelExam: boolean) {
  const runDir = join(runsDir, runId);
  if (!existsSync(join(runDir, "trace.jsonl.gz")) || !existsSync(join(runDir, "results.json"))) return undefined;
  const res = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")) as { cases: ScoredCase[] };
  const cases = relabelExam ? rescore({ ...(res as unknown as Result), cases: res.cases }).cases : res.cases;
  const risky = new Map(riskOf(cases).map((c) => [c.case_id, c]));
  const first = new Map<string, string>();
  for (const l of gunzipSync(readFileSync(join(runDir, "trace.jsonl.gz")))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)) {
    const e = JSON.parse(l) as { case_id?: string; agent: string; action: string; output_summary?: string };
    if (e.agent === "decision" && e.action === "recommend" && e.case_id && !first.has(e.case_id))
      first.set(e.case_id, e.output_summary ?? "");
  }
  const proposed = [...risky.keys()].filter((id) => first.get(id)?.startsWith("CLOSE_FALSE_POSITIVE"));
  const stopped = proposed.filter((id) => !closed(risky.get(id) as ScoredCase));
  return { proposed: proposed.length, stopped: stopped.length };
}

/** The run folder in eval/runs of a saved result, matched by its start time. */
const runIdOf = (r: Result | undefined) =>
  r
    ? runDirs
        .find((d) => {
          const meta = join(d, "run-meta.json");
          return (
            existsSync(meta) &&
            (JSON.parse(readFileSync(meta, "utf8")) as { started_at?: string }).started_at === r.started_at
          );
        })
        ?.split("/")
        .at(-1)
    : undefined;

function criticValue(link: (path: string) => string): string[] {
  if (!full) return [];
  const m = full.metrics;
  const out: string[] = [
    "**What the critic and challenger did, measured** (one run each; the counts are read from the result files, the run exports and the mutation test):",
    "",
  ];
  const firstId = runIdOf(full);
  const a = firstId ? firstClosesStopped(firstId, true) : undefined;
  const newest = newestFull && newestFull.run !== full ? newestFull : undefined;
  const newestId = newest ? runIdOf(newest.run) : undefined;
  const b = newestId ? firstClosesStopped(newestId, true) : undefined;
  if (a)
    out.push(
      `- **Closes stopped after the first answer:** in the first system's 70-case run, the decision step's first answer was a close on ${a.proposed} risk ${a.proposed === 1 ? "case" : "cases"}. The critic, challenger and policy guard stopped ${a.stopped} of ${a.proposed}${b && newest ? ` (${b.stopped} of ${b.proposed} in the run of ${newest.label})` : ""}.`,
    );
  out.push(
    `- **Critic:** in the first system's 70-case run it reviewed ${m.critic.reviewed} recommendations and sent ${m.critic.sent_back} back at least once. ${m.critic.unresolved} stayed unresolved after the allowed rounds; for those the policy guard set the outcome (by design it can only raise caution).`,
  );
  const mutation = resolveProjectPath("eval/critic-mutation.json");
  if (existsSync(mutation)) {
    const x = (JSON.parse(readFileSync(mutation, "utf8")) as { summary: Record<string, number> }).summary;
    out.push(
      `- **Critic's fact re-check, on its own:** it caught ${x.mutations_caught} of ${x.mutations} changed facts over ${x.decisions} decisions and approved ${x.unchanged_decisions_approved} of ${x.unchanged_decisions} unchanged ones ([mutation test](${link("eval/critic-mutation.json")})).`,
    );
  }
  const ch = m.challenger;
  if (ch) {
    const o = challengerOutcomes(full.variant, full.started_at);
    out.push(
      `- **Challenger:** in the same run it looked at ${ch.fired} proposed closes and turned ${ch.changed} into an escalation.${o.total > 0 ? ` It found a credible true-match argument in ${o.credible} of the ${o.total}, could not answer in ${o.unavailable}, and found no credible argument in ${o.none}.` : ""}`,
    );
  }
  const v3 = laterRuns.get("sys3|heldout3|routed");
  const v3single = laterRuns.get("sys3|heldout3|single");
  if (v3 && v3single) {
    const wrong = riskOf(v3.cases).filter(closed);
    const single = riskOf(v3single.cases).filter(closed).length;
    out.push(
      `- **Where the critic hurt:** on held-out v3 its citation rule caused both wrong closes (${wrong.map((c) => c.case_id).join(", ")}). It rejected the decision's escalation for citing the screener's signals, and the decision then closed. With the critic and challenger off, ${single} of ${riskOf(v3single.cases).length} risk cases were closed. Fixed in a later policy (version 8: a screener signal blocks a close, grounded or not); not re-measured blind on v3.`,
    );
  }
  return out;
}

const readmeNow = readFileSync(readmePath, "utf8");
const BOX_S = "<!-- results-box:start -->";
const BOX_E = "<!-- results-box:end -->";
const CV_S = "<!-- critic-value:start -->";
const CV_E = "<!-- critic-value:end -->";
let readmeNext = readmeNow;
const box = resultsBox();
if (box.length > 0 && readmeNext.includes(BOX_S) && readmeNext.includes(BOX_E))
  readmeNext = readmeNext.replace(new RegExp(`${BOX_S}[\\s\\S]*?${BOX_E}`), () => [BOX_S, ...box, BOX_E].join("\n"));
const cvReadme = criticValue((p) => p);
if (cvReadme.length > 0 && readmeNext.includes(CV_S) && readmeNext.includes(CV_E))
  readmeNext = readmeNext.replace(new RegExp(`${CV_S}[\\s\\S]*?${CV_E}`), () => [CV_S, ...cvReadme, CV_E].join("\n"));
const AT_S = "<!-- analyst-time:start -->";
const AT_E = "<!-- analyst-time:end -->";
const analystTime = analystTimeLines();
if (analystTime.length > 0 && readmeNext.includes(AT_S) && readmeNext.includes(AT_E))
  readmeNext = readmeNext.replace(new RegExp(`${AT_S}[\\s\\S]*?${AT_E}`), () =>
    [AT_S, ...analystTime, AT_E].join("\n"),
  );
if (readmeNext !== readmeNow) writeFileSync(readmePath, readmeNext);
const evaluationCv = readFileSync(evaluationPath, "utf8");
const cvDocs = criticValue((p) => `../${p}`);
if (cvDocs.length > 0 && evaluationCv.includes(CV_S) && evaluationCv.includes(CV_E))
  writeFileSync(
    evaluationPath,
    formatMarkdown(
      evaluationCv.replace(new RegExp(`${CV_S}[\\s\\S]*?${CV_E}`), () => [CV_S, ...cvDocs, CV_E].join("\n")),
      evaluationPath,
    ),
  );

console.log(
  `wrote eval/REPORT.md from ${have.length} variant(s)${notRun.length ? `; not run: ${notRun.join(", ")}` : ""}`,
);

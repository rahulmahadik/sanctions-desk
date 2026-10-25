/**
 * Run the 70-case exam against the real system and save the result.
 *
 *   npm run exam -- --variant routed          the full system, routed across the model lanes
 *   npm run exam -- --variant single          one recommendation, no critic, no memory
 *   npm run exam -- --variant local           reasoning off everywhere (local lane only)
 *   npm run exam -- --variant lightning       decision, critic and challenger sent under the guard identity (bound to the local model)
 *   npm run exam -- --variant rules           the labelled rules model instead of a language model
 *   npm run exam -- --variant fuzzy           baseline: name score threshold, no model, no data layer
 *   npm run exam -- --variant escalate_all    baseline: every alert goes to a person
 *   npm run exam -- --variant no_memory       the full system with memory off (previously cleared cases only)
 *
 * Options: --groups a,b  --kinds x,y  --limit N  --out <dir> (default eval/results)  --exam heldout|heldout2|heldout3|heldout4 (a held-out set, run ids eval-heldout-...),
 *   --system sys2 (the version of the system under test, put into run ids and the result). Results go to eval/results/<time>-<variant>.json and are
 * never edited by hand; eval/REPORT.md is built from them (npm run exam:report).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildTraceContract,
  escalateAll,
  fuzzyThreshold,
  PROVIDER_BACKOFF_MS,
  type ReviewRequest,
  readDecisionRecords,
  runReview,
  type ScoredCase,
  sampleRules,
  screenOutbound,
  summarise,
} from "@sanctions-desk/agents";
import {
  type ExamCaseRecord,
  HELDOUT_EXAM_FILE,
  HELDOUT2_EXAM_FILE,
  HELDOUT3_EXAM_FILE,
  HELDOUT4_EXAM_FILE,
  loadExam,
  MAIN_EXAM_FILE,
} from "@sanctions-desk/data";
import {
  buildGenerator,
  createFallbackRulesGenerator,
  createTraceLogger,
  forEvaluation,
  type Generator,
  loadConfig,
  loadPolicyFile,
  type Policy,
  projectRoot,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient } from "@sanctions-desk/zetaris";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const variant = flag("--variant") ?? "routed";
const groups = flag("--groups")?.split(",");
const kinds = flag("--kinds")?.split(",");
const tag = flag("--tag");
// --exam heldout, heldout2, heldout3 or heldout4 runs a held-out "beyond the rules" set instead of the main 70 cases.
const examName = flag("--exam") ?? "exam";
if (!["exam", "heldout", "heldout2", "heldout3", "heldout4"].includes(examName))
  throw new Error("--exam must be exam, heldout, heldout2, heldout3 or heldout4");
// --system names the version of the system under test (for example sys2); it goes into the run ids and the result, so
// runs of different versions never share a trace file.
const system = flag("--system");
if (system !== undefined && !/^[a-z0-9]+$/.test(system))
  throw new Error("--system must be lower-case letters and digits");
const runPrefix = `${examName === "exam" ? "eval" : `eval-${examName}`}${system ? `-${system}` : ""}`;
const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
const VARIANTS = ["routed", "single", "local", "lightning", "rules", "fuzzy", "escalate_all", "no_memory"];
if (!VARIANTS.includes(variant)) throw new Error(`--variant must be one of ${VARIANTS.join(", ")}`);

const baseConfig = loadConfig();
const config = forEvaluation(baseConfig);
let policy: Policy = loadPolicyFile(config.policy.file);
// --screener off: the ablation run, with every other change kept. Recorded in the run's features.
if (flag("--screener") === "off") policy = { ...policy, screener: { ...policy.screener, enabled: false } };
if (variant === "local") {
  const off = { thinking: "off" as const };
  policy = {
    ...policy,
    models: {
      ...policy.models,
      decision: { ...policy.models.decision, ...off, model: "fast" },
      critic: { ...policy.models.critic, ...off, model: "fast" },
    },
  };
}

if (variant === "lightning") {
  // A labelled comparison run: the decision, critic and challenger calls go out under the guard identity, which the
  // cockpit binds to the local model, so Nemotron 3.5 Lightning answers them all.
  const local = { model: "fast", identity: "guard" as const };
  policy = {
    ...policy,
    models: {
      ...policy.models,
      decision: { ...policy.models.decision, ...local },
      critic: { ...policy.models.critic, ...local },
      challenger: { ...policy.models.challenger, ...local },
    },
  };
}

const EXAM_FILES: Record<string, string> = {
  exam: MAIN_EXAM_FILE,
  heldout: HELDOUT_EXAM_FILE,
  heldout2: HELDOUT2_EXAM_FILE,
  heldout3: HELDOUT3_EXAM_FILE,
  heldout4: HELDOUT4_EXAM_FILE,
};
let cases: ExamCaseRecord[] = loadExam(EXAM_FILES[examName] as string).cases;
if (variant === "no_memory") cases = cases.filter((c) => c.group.startsWith("previously_cleared"));
if (groups) cases = cases.filter((c) => groups.includes(c.group));
if (kinds) cases = cases.filter((c) => kinds.includes(c.kind));
if (limit) cases = cases.slice(0, limit);

const alertScores = new Map(
  (
    JSON.parse(readFileSync(resolveProjectPath("data/synthetic/alert.json"), "utf8")) as Array<{
      alert_id: string;
      match_score: string;
    }>
  ).map((a) => [a.alert_id, Number(a.match_score)]),
);

const generator: Generator = variant === "rules" ? createFallbackRulesGenerator(sampleRules) : buildGenerator(config);
const zetaris = createZetarisClient({ config });
const logDir = config.logging.dir;
const now = () => new Date();

async function runCase(c: ExamCaseRecord): Promise<ScoredCase> {
  const base = {
    case_id: c.case_id,
    group: c.group,
    kind: c.kind,
    expected: c.expected,
    acceptable: c.acceptable,
    must_not: c.must_not,
  };
  if (variant === "escalate_all" || variant === "fuzzy") {
    if (c.alert_id === null) return { ...base, got: "DRAFT_ALLOWED" };
    const score = alertScores.get(c.alert_id) ?? 0;
    const got = variant === "escalate_all" ? escalateAll() : fuzzyThreshold(score, 0.9);
    return { ...base, got, ...(variant === "fuzzy" ? { score } : {}) };
  }
  const runId = `${runPrefix}-${variant}-${c.case_id}`;
  const trace = createTraceLogger({ runId, dir: logDir, stdout: false, policyVersion: policy.version });
  const deps = { config, policy, zetaris, generator, trace, now };
  const started = performance.now();
  if (c.alert_id === null) {
    const result = await screenOutbound(deps, c.draft ?? "");
    const calls = result.calls;
    return {
      ...base,
      got: result.violation ? "DRAFT_BLOCKED" : "DRAFT_ALLOWED",
      latency_s: round((performance.now() - started) / 1000),
      tokens_in: sum(calls.map((m) => m.tokens_in)),
      tokens_out: sum(calls.map((m) => m.tokens_out)),
      local_calls: calls.filter((m) => m.route_kind !== "cloud").length,
      cloud_calls: calls.filter((m) => m.route_kind === "cloud").length,
      cost: 0,
    };
  }
  const request: ReviewRequest = {
    runId,
    alertId: c.alert_id,
    sampleMode: false,
    options: {
      memory: variant !== "no_memory" && variant !== "single",
      critic: variant !== "single",
      challenger: variant !== "single",
    },
  };
  const res = await runReview(deps, request);
  const [record] = readDecisionRecords(logDir, (r) => r.run_id === runId);
  const trace4 = record ? buildTraceContract(record, config.costs) : undefined;
  return {
    ...base,
    got: res.decision ?? "ERROR",
    ...(record ? { confidence: record.confidence } : {}),
    latency_s: round((performance.now() - started) / 1000),
    tokens_in: trace4?.cost.totals.tokens_in,
    tokens_out: trace4?.cost.totals.tokens_out,
    local_calls: trace4?.cost.totals.local_calls,
    cloud_calls: trace4?.cost.totals.cloud_calls,
    cost: trace4?.cost.totals.total_cost,
    ...challengerFields(res, trace4),
    ...(res.path ? { path: res.path, first_finding: res.first_finding } : {}),
    critic_rounds: res.critic?.rounds,
    critic_final: res.critic?.final_verdict,
    decision_unavailable: unavailableOf(res.guards),
    decision_model: res.decision_model,
    decision_route: res.decision_route,
    decided_by_fallback: res.decided_by_fallback,
    model_last_recommendation: res.model_last_recommendation,
    critic_unresolved: res.critic_unresolved,
    screener: screenerFields(res.guards),
  };
}

/** Why no usable decision came back, when none did: the model service, an unusable answer, or a prompt not sent. */
function unavailableOf(guards: Array<{ guard: string; detail?: string }> | undefined) {
  const g = guards?.find((v) => v.guard === "model_decision");
  if (!g) return undefined;
  if (g.detail?.includes("service failed")) return "provider";
  return g.detail?.includes("not sent") ? "withheld" : "parsing";
}

/** The screener's verdict on this case, and whether a cloud route served it. */
function screenerFields(guards: Array<{ guard: string; verdict: string; detail?: string }> | undefined) {
  const v = guards?.find((g) => g.guard === "screener");
  return {
    verdict: v?.verdict,
    unavailable: v?.detail?.includes("screener unavailable") === true,
    served_by_cloud: guards?.some((g) => g.guard === "screener_locality") === true,
  };
}

/** What the challenger did on this case, read from the review's guards and the sealed record's model ledger. */
function challengerFields(
  res: { guards?: Array<{ guard: string; verdict: string }> },
  trace4: ReturnType<typeof buildTraceContract> | undefined,
) {
  const verdict = res.guards?.find((g) => g.guard === "challenger");
  if (!verdict) return {};
  const calls = trace4?.cost.models.filter((m) => m.agent === "challenger") ?? [];
  return {
    challenger_fired: true,
    challenger_changed: verdict.verdict === "block",
    challenger_s: round(sum(calls.map((m) => m.latency_ms)) / 1000),
    challenger_cost: sum(calls.map((m) => m.cost)),
  };
}

/**
 * How the Nightshift cockpit routes the app identities this run used, read from the runtime's own app-policy file when
 * this machine has it. The receipts say the same thing per call; this puts it in one line of the result file.
 */
function cockpitBinds(p: Policy): Record<string, string> | undefined {
  try {
    const file = join(homedir(), "Library", "Application Support", "ai.meterless.runtime", "state", "app-policy.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      { mode?: string | null; lanes?: string[] | null }
    >;
    const out: Record<string, string> = {};
    for (const identity of new Set(Object.values(p.models).map((m) => m.identity))) {
      const app = identity === "default" ? config.nightshift.appId : config.nightshift.apps?.[identity];
      if (app) out[app] = doc[app]?.mode ?? "unbound";
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The checked-out commit, marked when tracked files have changes that are not committed. */
function codeVersion(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    return dirty ? `${commit}+local changes` : commit;
  } catch {
    return "unknown"; // not a git checkout
  }
}

/**
 * What this run had: the code version and the settings that change behaviour, so a report can say which runs had what.
 * `commit` is read when the run starts (older result files without `commit_read` read it at the end); `commit_at_end`
 * is added only when the checkout changed during the run.
 */
function runFeatures(p: Policy) {
  const atEnd = codeVersion();
  return {
    commit: commitAtStart,
    ...(atEnd !== commitAtStart ? { commit_at_end: atEnd } : {}),
    commit_read: "at start",
    structured_output: p.structuredOutput,
    challenger: p.challenger,
    screener: { enabled: p.screener.enabled, confidence_threshold: p.screener.confidenceThreshold },
    cockpit_binds: cockpitBinds(p),
    app_identities: Object.fromEntries(Object.entries(p.models).map(([step, m]) => [step, m.identity])),
    tries_per_model_step: "own lane, then fast lane, then Ollama backup; a pause after a provider failure",
    retry_identities: Object.fromEntries(
      Object.entries(p.models).flatMap(([step, m]) => (m.retryIdentity ? [[step, m.retryIdentity]] : [])),
    ),
    // --note: a condition of the run that the code cannot see (for example how the payments table was served).
    ...(flag("--note") ? { note: flag("--note") } : {}),
    provider_backoff_ms: PROVIDER_BACKOFF_MS,
    challenger_points: "up to eight, strongest first",
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: Array<number | undefined>) => xs.reduce<number>((t, x) => t + (x ?? 0), 0);
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`case timed out after ${ms / 1000} s`)), ms)),
  ]);

const startedAt = new Date().toISOString();
const commitAtStart = codeVersion();
const outcomes: ScoredCase[] = [];
console.log(`exam variant ${variant}: ${cases.length} cases`);
// --thermal-gate <file>: a marker file that exists while the model runtime reports a serious thermal state. Before each
// case the run cools down for 25 s while it exists, and waits until it is gone once it has existed for over 10 minutes.
// Every pause and each case's posture are logged so the report can show whether provider failures track heat.
const gate = flag("--thermal-gate");
const pauseLog = join(logDir, `run-pauses-${runPrefix}-${variant}.jsonl`);
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logPause = (entry: Record<string, unknown>) =>
  appendFileSync(pauseLog, `${JSON.stringify({ ts: new Date().toISOString(), run: runPrefix, variant, ...entry })}\n`);
async function coolDown(caseId: string): Promise<{ posture: "normal" | "serious"; paused_s: number }> {
  if (!gate || !existsSync(gate)) return { posture: "normal", paused_s: 0 };
  const started = Date.now();
  if (Date.now() - statSync(gate).mtimeMs > 10 * 60_000) {
    logPause({ case_id: caseId, event: "paused", reason: "thermal serious for over 10 minutes" });
    while (existsSync(gate)) await nap(30_000);
    logPause({ case_id: caseId, event: "resumed", waited_s: Math.round((Date.now() - started) / 1000) });
  } else {
    await nap(25_000);
    logPause({ case_id: caseId, event: "cool_down", waited_s: 25 });
  }
  return { posture: "serious", paused_s: Math.round((Date.now() - started) / 1000) };
}

for (const c of cases) {
  const thermal = await coolDown(c.case_id);
  try {
    const outcome = {
      ...(await withTimeout(runCase(c), 10 * 60_000)),
      thermal_posture: thermal.posture,
      paused_s: thermal.paused_s,
    };
    outcomes.push(outcome);
    const ok = outcome.got === c.expected || c.acceptable.includes(outcome.got as never);
    console.log(
      `${c.case_id} ${c.kind.padEnd(28)} ${outcome.got.padEnd(22)} ${ok ? "ok " : "MISS"} ${outcome.latency_s ?? "-"}s`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcomes.push({
      case_id: c.case_id,
      group: c.group,
      kind: c.kind,
      expected: c.expected,
      acceptable: c.acceptable,
      must_not: c.must_not,
      got: "ERROR",
      error: message.slice(0, 300),
    });
    console.log(`${c.case_id} ${c.kind.padEnd(28)} ERROR ${message.slice(0, 120)}`);
  }
}

const metrics = summarise(outcomes);
// --out <dir> writes the result somewhere else (for example a git-ignored folder for a run outside the evaluation).
const dir = resolveProjectPath(flag("--out") ?? "eval/results");
mkdirSync(dir, { recursive: true });
const file = join(
  dir,
  `${startedAt.replace(/[:.]/g, "-")}-${examName === "exam" ? "" : `${examName}-`}${system ? `${system}-` : ""}${variant}${tag ? `-${tag}` : ""}.json`,
);
const describeModels = (p: Policy) =>
  Object.fromEntries(
    Object.entries(p.models).map(([k, v]) => [
      k,
      `${v.model} / ${typeof v.thinking === "object" ? `reasoning ${v.thinking.budgetTokens}` : v.thinking}`,
    ]),
  );
writeFileSync(
  file,
  `${JSON.stringify({ variant, ...(examName === "exam" ? {} : { exam: examName }), ...(system ? { system } : {}), ...(tag ? { tag } : {}), features: runFeatures(policy), selection: { groups, kinds: kinds?.length, limit }, started_at: startedAt, finished_at: new Date().toISOString(), policy_version: policy.version, models: describeModels(policy), cases: outcomes, metrics }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    exact: metrics.exact_accuracy,
    acceptable: metrics.acceptable_accuracy,
    false_close_rate: metrics.false_close_rate,
    errors: metrics.errors,
    latency: metrics.latency_s,
  }),
);
console.log(`saved ${file}`);
// Open connections (the Zetaris client's keep-alive sockets) would keep the process alive after the result is saved.
process.exit(0);

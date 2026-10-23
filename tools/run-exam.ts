/**
 * Run the 60-case exam against the real system and save the result.
 *
 *   npm run exam -- --variant routed          the full system, routed across the model lanes
 *   npm run exam -- --variant single          one recommendation, no critic, no memory
 *   npm run exam -- --variant local           reasoning off everywhere (local lane only)
 *   npm run exam -- --variant rules           the labelled rules model instead of a language model
 *   npm run exam -- --variant fuzzy           baseline: name score threshold, no model, no data layer
 *   npm run exam -- --variant escalate_all    baseline: every alert goes to a person
 *   npm run exam -- --variant no_memory       the full system with memory off (previously cleared cases only)
 *
 * Options: --groups a,b  --kinds x,y  --limit N. Results go to eval/results/<time>-<variant>.json and are
 * never edited by hand; eval/REPORT.md is built from them (npm run exam:report).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { type ExamCaseRecord, loadExam } from "@sanctions-desk/data";
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
const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
const VARIANTS = ["routed", "single", "local", "rules", "fuzzy", "escalate_all", "no_memory"];
if (!VARIANTS.includes(variant)) throw new Error(`--variant must be one of ${VARIANTS.join(", ")}`);

const baseConfig = loadConfig();
const config = forEvaluation(baseConfig);
let policy: Policy = loadPolicyFile(config.policy.file);
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

let cases: ExamCaseRecord[] = loadExam().cases;
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
  const runId = `eval-${variant}-${c.case_id}`;
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
    decision_unavailable: res.guards?.some((g) => g.guard === "model_decision")
      ? res.guards.some((g) => g.guard === "model_decision" && g.detail?.includes("service failed"))
        ? "provider"
        : "parsing"
      : undefined,
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

/** What this run had: the code version and the settings that change behaviour, so a report can say which runs had what. */
function runFeatures(p: Policy) {
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    if (dirty) commit += "+local changes";
  } catch {
    // not a git checkout
  }
  return {
    commit,
    structured_output: p.structuredOutput,
    challenger: p.challenger,
    tries_per_model_step: "own lane, then fast lane, then Ollama backup; a pause after a provider failure",
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
const outcomes: ScoredCase[] = [];
console.log(`exam variant ${variant}: ${cases.length} cases`);
for (const c of cases) {
  try {
    const outcome = await withTimeout(runCase(c), 10 * 60_000);
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
const dir = resolveProjectPath("eval/results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${startedAt.replace(/[:.]/g, "-")}-${variant}${tag ? `-${tag}` : ""}.json`);
const describeModels = (p: Policy) =>
  Object.fromEntries(
    Object.entries(p.models).map(([k, v]) => [
      k,
      `${v.model} / ${typeof v.thinking === "object" ? `reasoning ${v.thinking.budgetTokens}` : v.thinking}`,
    ]),
  );
writeFileSync(
  file,
  `${JSON.stringify({ variant, ...(tag ? { tag } : {}), features: runFeatures(policy), selection: { groups, kinds: kinds?.length, limit }, started_at: startedAt, finished_at: new Date().toISOString(), policy_version: policy.version, models: describeModels(policy), cases: outcomes, metrics }, null, 2)}\n`,
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

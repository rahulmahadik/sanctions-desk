/**
 * One command that checks the main claims from a clone, with no credentials and no services: a sample-mode review
 * end to end, the engine conformance suites, the signed evidence of the saved runs, the role and four-eyes tests,
 * the preregistered held-out files and a scan for secrets. It prints one PASS or FAIL line per check and a summary,
 * and exits with 1 if any check fails.
 *
 *   npm run prove                    run every check here
 *   npm run prove -- --write         also write eval/PROVE.md and the README block between the prove markers
 *   npm run prove -- --verbose       also print what each check printed
 *   npm run prove -- --fresh         clone this commit into a temporary folder, run `npm ci` there and run the
 *                                    checks inside it (needs network for npm; takes a few minutes)
 *
 * Sample mode is forced: the review replays saved Zetaris answers and uses the labelled rules-based model, the
 * child checks get only PATH, HOME and temporary-folder variables plus SAMPLE_MODE=true, and the .env file is never
 * read. Each run is also logged as JSON lines to logs/prove-<time>.jsonl.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadPolicyFile,
  PolicyStore,
  projectRoot,
  RunEventBus,
  verifyDecisionRecord,
} from "@sanctions-desk/shared";
import { buildApp } from "../apps/api/src/app.js";
import { createLogger } from "../apps/api/src/logger.js";
import { SAMPLE_NOTICE, sampleGenerator, sampleZetaris } from "../apps/api/src/sample.js";
import { problemsIn, verifyExportedRun } from "./lib/evidence.js";
import {
  type Check,
  type CheckOutcome,
  type CheckResult,
  countSecrets,
  exitCodeFor,
  formatLine,
  PROVE_END,
  PROVE_START,
  proveMarkdown,
  type RunInfo,
  readmeBlock,
  replaceBlock,
  runCheck,
  runChild,
  sampleEnv,
  summaryLine,
} from "./lib/prove.js";

const ROOT = projectRoot();
const ALERT = "ALR-0004";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const args = new Set(process.argv.slice(2));
const bin = (name: string): string =>
  join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const git = (gitArgs: string[]): string =>
  execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 1 << 28 }).trim();

// ---- 1. a sample-mode review, end to end ----------------------------------------------------------------------------

interface ReviewAnswer {
  status?: string;
  decision?: string;
  record_id?: string;
  record_hash?: string;
  sample_mode?: boolean;
  sample_notice?: string;
  human_review_required?: boolean;
}

/** What is wrong with the answer and the sealed record it points at; empty when nothing is. */
function answerProblems(body: ReviewAnswer, recordFile: string): string[] {
  const problems: string[] = [];
  if (body.status !== "ok") problems.push(`status ${body.status}`);
  if (!body.sample_mode || !body.sample_notice?.startsWith("Sample mode")) problems.push("no sample notice");
  if (!body.record_hash || !SHA256_HEX.test(body.record_hash)) problems.push("no sha256 record hash");
  if (body.human_review_required !== true) problems.push("not marked for human review");
  if (!existsSync(recordFile)) return [...problems, "no sealed record on disk"];
  const record = JSON.parse(readFileSync(recordFile, "utf8")) as { record_hash?: string };
  if (!verifyDecisionRecord(record)) problems.push("the record hash does not verify");
  if (record.record_hash !== body.record_hash) problems.push("the record on disk differs from the answer");
  return problems;
}

async function sampleReview(): Promise<CheckOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "sanctions-desk-prove-"));
  try {
    const overridesPath = join(dir, "overrides.json");
    writeFileSync(
      overridesPath,
      JSON.stringify({
        logging: { stdout: false, dir: join(dir, "logs") },
        actions: { outboxDir: join(dir, "outbox") },
      }),
    );
    // An explicit environment: nothing from the shell, .env or config/local.json is read.
    const config = loadConfig({ env: { SAMPLE_MODE: "true", AUTH_MODE: "demo" }, overridesPath });
    const app = await buildApp({
      config,
      logger: createLogger(config),
      generator: sampleGenerator(),
      zetaris: sampleZetaris(config),
      sampleNotice: SAMPLE_NOTICE,
      bus: new RunEventBus({ replayLimit: config.events.replayLimit, maxRuns: config.events.maxRuns }),
      policies: new PolicyStore(loadPolicyFile(config.policy.file)),
    });
    try {
      const res = await app.inject({ method: "POST", url: "/run", payload: { alert_id: ALERT } });
      if (res.statusCode !== 200)
        return { ok: false, detail: `POST /run answered ${res.statusCode}`, output: res.body.slice(0, 4000) };
      const body = res.json() as ReviewAnswer;
      const output = JSON.stringify(
        { http_status: res.statusCode, ...body, sample_notice: body.sample_notice ? "(present)" : undefined },
        null,
        2,
      );
      const problems = answerProblems(body, join(dir, "logs", "records", `${body.record_id}.json`));
      return problems.length > 0
        ? { ok: false, detail: problems.join("; "), output }
        : {
            ok: true,
            detail: `POST /run ${ALERT} -> ${body.decision}, sealed record ${body.record_hash?.slice(0, 12)}… verifies, sample notice shown, human review required`,
            output,
          };
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. engine conformance ----------------------------------------------------------------------------------------

async function engines(): Promise<CheckOutcome> {
  const r = await runChild(bin("tsx"), [join(ROOT, "tools", "test-engines.ts")], {
    cwd: ROOT,
    env: sampleEnv(),
    timeoutMs: 170_000,
  });
  const scores = [...r.output.matchAll(/^(PASS|FAIL) (H-MEM|World Model|Markovian): (\d+\/\d+) checks passed/gm)];
  const detail =
    scores.length > 0
      ? scores.map((m) => `${m[2]} ${m[3]}${m[1] === "FAIL" ? " (failed)" : ""}`).join(", ")
      : r.timedOut
        ? "timed out"
        : "no scorecard printed";
  return { ok: r.code === 0 && scores.length === 3 && scores.every((m) => m[1] === "PASS"), detail, output: r.output };
}

// ---- 3. signed evidence -------------------------------------------------------------------------------------------

async function evidence(): Promise<CheckOutcome> {
  const base = join(ROOT, "eval", "runs");
  const dirs = existsSync(base) ? readdirSync(base).map((n) => join(base, n)) : [];
  if (dirs.length === 0) return { ok: false, detail: "no exported runs in eval/runs" };
  // Pinned keys come only from the committed configuration, never from .env.
  const trusted = [...loadConfig({ env: { SAMPLE_MODE: "true" } }).nightshift.receiptPublicKeys];
  let receipts = 0;
  let valid = 0;
  let pinned = 0;
  let calls = 0;
  let missing = 0;
  let mismatched = 0;
  let bad = 0;
  const lines: string[] = [];
  for (const dir of dirs) {
    const v = verifyExportedRun(dir, trusted);
    const total = v.status.valid_pinned + v.status.valid_unpinned + v.status.invalid + v.status.malformed;
    receipts += total;
    valid += v.status.valid_pinned + v.status.valid_unpinned;
    pinned += v.status.valid_pinned;
    calls += v.calls;
    missing += v.missing.length;
    mismatched += v.mismatched.length;
    bad += problemsIn(v);
    lines.push(
      `${v.runId}: ${total} receipts (${v.status.invalid} invalid, ${v.status.malformed} malformed), ${v.calls} model calls, ${v.missing.length} without a receipt, ${v.mismatched.length} model mismatches`,
    );
  }
  const keyNote = pinned === valid ? "signing key pinned" : "signing key taken from each receipt, not pinned";
  return {
    ok: bad === 0 && receipts > 0,
    detail: `${dirs.length} runs: ${valid}/${receipts} receipts verified (${keyNote}); ${calls - missing}/${calls} model calls have a receipt; ${mismatched} trace/receipt model mismatches`,
    output: lines.join("\n"),
  };
}

// ---- 4. roles and four-eyes ---------------------------------------------------------------------------------------

const ACCESS_TESTS = ["apps/api/test/pentest-access.test.ts", "apps/api/test/people.test.ts"];

async function rolesAndFourEyes(): Promise<CheckOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "sanctions-desk-prove-"));
  try {
    const report = join(dir, "vitest.json");
    const r = await runChild(bin("vitest"), ["run", ...ACCESS_TESTS, "--reporter=json", `--outputFile=${report}`], {
      cwd: ROOT,
      env: sampleEnv(),
      timeoutMs: 170_000,
    });
    if (!existsSync(report))
      return {
        ok: false,
        detail: r.timedOut ? "timed out" : `vitest wrote no report (exit ${r.code})`,
        output: r.output,
      };
    const json = JSON.parse(readFileSync(report, "utf8")) as {
      numTotalTests: number;
      numPassedTests: number;
      numFailedTests: number;
      testResults: Array<{ name: string; assertionResults: Array<{ status: string; fullName: string }> }>;
    };
    const perFile = ACCESS_TESTS.map((f) => {
      const t = json.testResults.find((x) => x.name.endsWith(f));
      const a = t?.assertionResults ?? [];
      return `${f.split("/").at(-1)?.replace(".test.ts", "")} ${a.filter((x) => x.status === "passed").length}/${a.length}`;
    });
    const failedNames = json.testResults
      .flatMap((t) => t.assertionResults)
      .filter((a) => a.status === "failed")
      .map((a) => `failed: ${a.fullName}`);
    return {
      ok:
        r.code === 0 &&
        json.numFailedTests === 0 &&
        json.numTotalTests > 0 &&
        json.testResults.length === ACCESS_TESTS.length,
      detail: `${json.numPassedTests}/${json.numTotalTests} tests passed (${perFile.join(", ")}), ${json.numFailedTests} failed`,
      output: [...failedNames, r.output].join("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 5. preregistration -------------------------------------------------------------------------------------------

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

interface Findings {
  problems: string[];
  notes: string[];
}

/** Held-out v1: the test pins hashes of the first 18 and 22 cases (freezes 1 and 2), over sorted keys. */
function heldoutV1(f: Findings): void {
  const pins = [
    ...read("packages/agents/test/heldout-standard.test.ts").matchAll(
      /hashOf\(frozen\.cases\.slice\(0, (\d+)\)\)\)\.toBe\("([0-9a-f]{64})"\)/g,
    ),
  ];
  const cases = (JSON.parse(read("eval/cases/heldout.json")) as { cases: unknown[] }).cases;
  if (pins.length === 0) f.problems.push("no pinned hash found for heldout.json");
  for (const [, n, pin] of pins) {
    if (sha256(JSON.stringify(sortKeys(cases.slice(0, Number(n))))) === pin)
      f.notes.push(`heldout.json cases 1-${n} match`);
    else f.problems.push(`heldout.json cases 1-${n} differ from the pinned hash`);
  }
}

/** Held-out v2: the test pins the file's own hash, and the case README records the same hash. */
function heldoutV2(f: Findings): void {
  const pin = /FROZEN_SHA256 = "([0-9a-f]{64})"/.exec(read("packages/agents/test/heldout2-standard.test.ts"))?.[1];
  if (!pin) {
    f.problems.push("no pinned hash found for heldout2.json");
    return;
  }
  if (sha256(read("eval/cases/heldout2.json")) !== pin) f.problems.push("heldout2.json differs from the pinned hash");
  else f.notes.push("heldout2.json file hash matches");
  if (!read("eval/cases/README.md").includes(pin)) f.problems.push("eval/cases/README.md records another hash");
}

/** The final freeze commit of the second held-out set is in this history. */
function freezeCommit(f: Findings): void {
  const freeze = (JSON.parse(read("eval/cases/heldout2-changes.json")) as { final_freeze_commit?: string })
    .final_freeze_commit;
  if (!freeze || !/^[0-9a-f]{7,40}$/.test(freeze)) {
    f.problems.push("no final freeze commit recorded");
    return;
  }
  try {
    git(["merge-base", "--is-ancestor", freeze, "HEAD"]);
    f.notes.push(`held-out v2 freeze commit ${freeze} is in the history`);
  } catch {
    f.problems.push(`freeze commit ${freeze} is not in this history (a shallow clone has too little history)`);
  }
}

async function preregistration(): Promise<CheckOutcome> {
  const f: Findings = { problems: [], notes: [] };
  heldoutV1(f);
  heldoutV2(f);
  freezeCommit(f);
  return {
    ok: f.problems.length === 0,
    detail: f.problems.length === 0 ? f.notes.join("; ") : f.problems.join("; "),
    output: [...f.notes, ...f.problems].join("\n"),
  };
}

// ---- 6. no secrets in the tree ------------------------------------------------------------------------------------

const TEXT = /\.(ts|tsx|mts|js|mjs|cjs|json|jsonl|md|yml|yaml|toml|txt|py|sh|sql|example|html|css|csv)$/;
const PLAIN = new Set(["Dockerfile", ".gitignore", ".dockerignore", ".env.example"]);
/** Tests hold made-up keys on purpose, as the repository scan also allows. */
const scannable = (file: string): boolean =>
  !/(^|\/)test\//.test(file) && (TEXT.test(file) || PLAIN.has(file.split("/").at(-1) ?? ""));
const readOrEmpty = (file: string): string => {
  try {
    return readFileSync(join(ROOT, file), "utf8");
  } catch {
    return "";
  }
};

async function secrets(): Promise<CheckOutcome> {
  const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const envFiles = files.filter((f) => /(^|\/)\.env($|\.(?!example$))/.test(f));
  const scanned = files.filter(scannable);
  const totals = new Map<string, number>();
  const where: string[] = [];
  for (const file of scanned) {
    const counts = countSecrets(readOrEmpty(file));
    for (const [name, n] of counts) totals.set(name, (totals.get(name) ?? 0) + n);
    if (counts.size > 0) where.push(`${file}: ${[...counts.values()].reduce((a, b) => a + b, 0)}`);
  }
  const found = [...totals.values()].reduce((a, b) => a + b, 0);
  const counts = [...totals].map(([k, n]) => `${k}: ${n}`).join(", ");
  const clean = found === 0 && envFiles.length === 0;
  return {
    ok: clean,
    detail: clean
      ? `${scanned.length} tracked text files scanned: 0 credential-bearing URLs, private keys or tokens; no .env file tracked`
      : `${found} possible secrets (${counts || "none"}), ${envFiles.length} .env files tracked`,
    // File names and counts only; the matched text is never shown.
    output: where.join("\n"),
  };
}

// ---- running ------------------------------------------------------------------------------------------------------

const CHECKS: Check[] = [
  { name: "Sample-mode review", timeoutMs: 90_000, run: sampleReview },
  { name: "Engine conformance", timeoutMs: 180_000, run: engines },
  { name: "Signed evidence", timeoutMs: 120_000, run: evidence },
  { name: "Roles and four-eyes", timeoutMs: 180_000, run: rolesAndFourEyes },
  { name: "Preregistration", timeoutMs: 30_000, run: preregistration },
  { name: "No secrets in the tree", timeoutMs: 60_000, run: secrets },
];

function runInfo(fresh: boolean): RunInfo {
  let commit = "unknown";
  let dirty = false;
  try {
    commit = git(["rev-parse", "--short", "HEAD"]);
    dirty = !fresh && git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
  } catch {
    // not a git checkout; the preregistration check says so
  }
  return {
    time: new Date().toISOString(),
    commit,
    dirty,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    fresh,
  };
}

function write(info: RunInfo, results: CheckResult[]): void {
  writeFileSync(join(ROOT, "eval", "PROVE.md"), proveMarkdown(info, results));
  const readme = join(ROOT, "README.md");
  writeFileSync(readme, replaceBlock(readFileSync(readme, "utf8"), readmeBlock(info, results)));
  console.log(`\nwrote eval/PROVE.md and the README block between ${PROVE_START} and ${PROVE_END}`);
}

function log(info: RunInfo, results: CheckResult[]): void {
  try {
    const dir = join(ROOT, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `prove-${info.time.replace(/[:.]/g, "-")}.jsonl`);
    for (const r of results)
      appendFileSync(
        file,
        `${JSON.stringify({ ts: info.time, agent: "prove", action: "check", commit: info.commit, check: r.name, status: r.status, detail: r.detail, latency_ms: r.ms, output_tail: r.output.slice(-2000) })}\n`,
      );
  } catch {
    // logging is best effort; the printed list is the result
  }
}

const indent = (text: string, lines = 40): string =>
  text
    .trim()
    .split("\n")
    .slice(-lines)
    .map((l) => `      ${l}`)
    .join("\n");

async function local(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    const r = await runCheck(check);
    results.push(r);
    console.log(formatLine(r));
    if (r.output && (r.status === "FAIL" || args.has("--verbose"))) console.log(indent(r.output));
  }
  return results;
}

/** Clone this commit into a temporary folder, install there and run the same checks; their results come back as JSON. */
async function fresh(): Promise<CheckResult[]> {
  const dir = mkdtempSync(join(tmpdir(), "sanctions-desk-fresh-"));
  const clone = join(dir, "sanctions-desk");
  try {
    console.log(
      `cloning HEAD into ${clone} (committed files only) and running npm ci; this needs network and takes a few minutes`,
    );
    execFileSync("git", ["clone", "--local", "--quiet", ROOT, clone], { stdio: "inherit", timeout: 300_000 });
    execFileSync("git", ["checkout", "--quiet", "--detach", git(["rev-parse", "HEAD"])], {
      cwd: clone,
      stdio: "inherit",
      timeout: 60_000,
    });
    const install = await runChild("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: clone,
      env: { ...sampleEnv(), npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME ?? dir, ".npm") },
      timeoutMs: 900_000,
    });
    if (install.code !== 0) {
      console.log(indent(install.output));
      return [{ name: "Fresh install", status: "FAIL", detail: `npm ci exited ${install.code}`, ms: 0, output: "" }];
    }
    const out = join(dir, "results.json");
    const child = await runChild(
      join(clone, "node_modules", ".bin", "tsx"),
      [join(clone, "tools", "prove.ts"), "--results-json", out, ...(args.has("--verbose") ? ["--verbose"] : [])],
      { cwd: clone, env: sampleEnv(), timeoutMs: 900_000 },
    );
    console.log(child.output.trimEnd());
    return existsSync(out)
      ? (JSON.parse(readFileSync(out, "utf8")) as CheckResult[])
      : [{ name: "Fresh run", status: "FAIL", detail: "the checks in the clone wrote no results", ms: 0, output: "" }];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const isFresh = args.has("--fresh");
  const info = runInfo(isFresh);
  const results = isFresh ? await fresh() : await local();
  const jsonAt = process.argv.indexOf("--results-json");
  const resultsFile = jsonAt > 0 ? process.argv[jsonAt + 1] : undefined;
  // Inside a fresh clone the caller prints the summary; printing it here as well would show it twice.
  if (resultsFile) writeFileSync(resultsFile, JSON.stringify(results));
  else console.log(summaryLine(results));
  log(info, results);
  if (args.has("--write")) write(info, results);
  return exitCodeFor(results);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`FAIL: prove stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

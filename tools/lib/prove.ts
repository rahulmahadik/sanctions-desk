/**
 * The parts of `npm run prove` that do not touch the outside world: running a check under a time limit, the
 * PASS/FAIL lines and summary, the exit code, the Markdown written by `--write`, the README block, the child
 * process environment and the pattern scan for secrets. Kept apart so they can be unit tested.
 */
import { spawn } from "node:child_process";

export type Status = "PASS" | "FAIL";

export interface CheckOutcome {
  ok: boolean;
  /** One short line: what was checked and what was found. Never a secret. */
  detail: string;
  /** Everything the check printed or collected, shown only when it fails (or with --verbose). */
  output?: string;
}

export interface Check {
  name: string;
  timeoutMs: number;
  run: () => Promise<CheckOutcome>;
}

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  ms: number;
  output: string;
}

/** Run one check. A throw or a timeout is a FAIL with the reason as its detail; nothing escapes. */
export async function runCheck(check: Check, now: () => number = Date.now): Promise<CheckResult> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, detail: `timed out after ${Math.round(check.timeoutMs / 1000)} s` }),
      check.timeoutMs,
    );
  });
  let outcome: CheckOutcome;
  try {
    outcome = await Promise.race([check.run(), timeout]);
  } catch (err) {
    outcome = { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
  return {
    name: check.name,
    status: outcome.ok ? "PASS" : "FAIL",
    detail: redact(outcome.detail),
    ms: now() - started,
    output: redact(outcome.output ?? ""),
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** One line per check: `PASS  Name: detail (1.2 s)`. */
export function formatLine(r: CheckResult): string {
  return `${r.status}  ${r.name}: ${r.detail} (${seconds(r.ms)})`;
}

export function summaryLine(results: CheckResult[]): string {
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").map((r) => r.name);
  if (results.length === 0) return "FAIL: no checks ran";
  return failed.length === 0
    ? `PASS: ${passed} of ${results.length} checks passed`
    : `FAIL: ${passed} of ${results.length} checks passed; failed: ${failed.join(", ")}`;
}

/** 0 only when at least one check ran and every check passed. */
export function exitCodeFor(results: CheckResult[]): number {
  return results.length > 0 && results.every((r) => r.status === "PASS") ? 0 : 1;
}

export interface RunInfo {
  /** ISO time on the machine that ran the checks. */
  time: string;
  commit: string;
  /** True when the working tree had changes that are not committed. */
  dirty: boolean;
  node: string;
  platform: string;
  fresh: boolean;
}

export const REPRODUCE = "npm ci && npm run prove";

const commitText = (info: RunInfo): string => `${info.commit}${info.dirty ? " (with uncommitted changes)" : ""}`;

/** eval/PROVE.md: when, on which commit, and every line. */
export function proveMarkdown(info: RunInfo, results: CheckResult[]): string {
  return [
    "# One-command proof",
    "",
    "Written by `npm run prove -- --write`. Every line comes from that run; nothing here is edited by hand.",
    "",
    `- Machine time: ${info.time}`,
    `- Commit: ${commitText(info)}`,
    `- Node ${info.node} on ${info.platform}${info.fresh ? ", in a fresh clone with `npm ci`" : ""}`,
    `- Reproduce: \`${REPRODUCE}\` (or \`npm run prove -- --fresh\` to run it in a clean clone)`,
    "",
    "```text",
    ...results.map(formatLine),
    summaryLine(results),
    "```",
    "",
  ].join("\n");
}

/** The README block: the list, when and where it ran, and how to run it again. */
export function readmeBlock(info: RunInfo, results: CheckResult[]): string {
  return [
    `**One-command proof** (\`npm run prove\`, no credentials or services; last run ${info.time} on commit ${commitText(info)}):`,
    "",
    "```text",
    ...results.map(formatLine),
    summaryLine(results),
    "```",
    "",
    `Reproduce with \`${REPRODUCE}\`, or \`npm run prove -- --fresh\` to clone this commit into a temporary folder, install and run the same checks there. The sealed-record hash in the first line changes on every run (the record holds its own run id and time); the other figures do not. Details: [eval/PROVE.md](eval/PROVE.md).`,
  ].join("\n");
}

export const PROVE_START = "<!-- prove:start -->";
export const PROVE_END = "<!-- prove:end -->";

/** Replace what is between the markers. Throws when the markers are missing or out of order. */
export function replaceBlock(text: string, body: string, start = PROVE_START, end = PROVE_END): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < 0 || b < a) throw new Error(`markers ${start} and ${end} not found in order`);
  return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
}

/**
 * The environment a child check runs with: only what is needed to find programs and temporary folders, plus
 * sample mode. Nothing from the caller's shell (keys, tokens, service addresses) is passed on.
 */
const KEEP = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "ComSpec", "USERPROFILE"];
export function sampleEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEEP) if (from[k] !== undefined) env[k] = from[k];
  return { ...env, SAMPLE_MODE: "true", AUTH_MODE: "demo", NO_COLOR: "1", FORCE_COLOR: "0" };
}

export interface ChildResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Run a program with a time limit and capture what it prints. The child is killed when the time is up. */
export function runChild(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));
    child.on("error", (err) => chunks.push(`\n${err.message}\n`));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: chunks.join(""), timedOut });
    });
  });
}

// ---- secrets ------------------------------------------------------------------------------------------------------

/**
 * Patterns for credentials that must never be committed. Built from parts so this file does not match itself.
 * A URL counts only when it carries a password that is not an obvious placeholder.
 */
const DASHES = "-{5}";
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "credential in a URL",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`<>]+:(?!\$\{|<|\*{3}|password@|pass@|secret@|changeme@|xxx)[^\s/@"'`<>]{3,}@[\w.-]+/i,
  },
  { name: "private key", re: new RegExp(`${DASHES}BEGIN [A-Z ]*PRIVATE KEY${DASHES}`) },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/ },
  {
    name: "key or token assignment",
    re: /\b(api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{28,}/i,
  },
  { name: "cloud access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "code host token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  {
    name: "chat or model service key",
    re: /\b(xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{32,}|nvapi-[A-Za-z0-9_-]{32,})\b/,
  },
  {
    name: "connection string with a password",
    re: /\b(jdbc:|odbc:|Server=|Data Source=)[^\n]*\b(password|pwd)=(?!\$|<|\{)[^;\s"'&]{4,}/i,
  },
];

/** Count matches of each pattern in a text. Only counts are kept, never the matched text. */
export function countSecrets(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  }
  return counts;
}

/** Mask anything that looks like a credential before it is printed or written. */
export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS)
    out = out.replace(new RegExp(p.re.source, `${p.re.flags.replace("g", "")}g`), `[${p.name} removed]`);
  return out;
}

/**
 * The receipt log of the static site (site/receipts/): every model call of every committed run export, one page per
 * run, with the mode the desk asked for, the model the trace recorded, the model the signed receipt names, and the
 * result of checking the signature when the page was built. It reads only eval/runs/<run-id>/ (the trace and the
 * receipts) and shows ids, steps, models, timings and token counts, never prompt text.
 *
 * The build stops (throws RecordedRunError) when a call names a receipt the export does not hold, when a signature
 * does not verify, when the trace and the receipt disagree, or when the run fails `npm run evidence:verify`, so the
 * published log can only show receipts that check out against the committed files.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { problemsIn, verifyExportedRun } from "./evidence.js";
import {
  BANNER,
  type CheckedCall,
  checkCalls,
  esc,
  REPO_URL,
  RecordedRunError,
  RUNS_CSS,
  readRunFiles,
  type TraceEvent,
} from "./runs-site.js";

/** The step names the log shows; the safety guard's calls are recorded under `policy_guard`. */
export const STEP_NAMES: Record<string, string> = {
  policy_guard: "Safety guard",
  screener: "Screener",
  decision: "Decision",
  critic: "Critic",
  challenger: "Challenger",
};

export interface LoggedCall extends CheckedCall {
  caseId: string;
  provider?: string;
}

export interface RunLog {
  runId: string;
  policyVersion?: number;
  startedAt?: string;
  calls: LoggedCall[];
  /** Calls whose receipt verified when the log was built. */
  verified: number;
}

export interface ReceiptLogOptions {
  /** Folder holding the run exports (default: eval/runs). */
  runsDir?: string;
  /** Pinned receipt keys. Empty by default, so the check is the one anyone can repeat from the committed files. */
  trustedKeys?: readonly string[];
}

/** Load one run's model calls, checking every receipt they name and the whole run as `evidence:verify` does. */
export function loadRunLog(runDir: string, opts: ReceiptLogOptions = {}): RunLog {
  const runId = runDir.split("/").filter(Boolean).at(-1) ?? runDir;
  const { meta, envelopes, trace } = readRunFiles(runDir, runId);
  const byCase = new Map<string, TraceEvent[]>();
  for (const e of trace) byCase.set(e.case_id, [...(byCase.get(e.case_id) ?? []), e]);
  const calls: LoggedCall[] = [];
  for (const [caseId, events] of [...byCase].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const answers = sorted.filter((e) => e.action === "model_answer");
    const checked = checkCalls(sorted, envelopes, opts.trustedKeys ?? [], `${runId} ${caseId}`);
    checked.forEach((c, i) => {
      const provider = (answers[i] as TraceEvent & { provider?: string }).provider;
      // The rules stand-in of a baseline variant answers in the same event shape, but it is not a model call.
      if (provider !== "fallback-rules") calls.push({ ...c, caseId, provider });
    });
  }
  const run = verifyExportedRun(runDir, [...(opts.trustedKeys ?? [])]);
  if (problemsIn(run) > 0)
    throw new RecordedRunError(
      `${runId}: the run fails npm run evidence:verify (${run.status.invalid} invalid, ${run.status.malformed} malformed, ${run.missing.length} missing, ${run.mismatched.length} model mismatches)`,
    );
  return {
    runId,
    policyVersion: meta.policy_version,
    startedAt: meta.started_at,
    calls,
    verified: calls.filter((c) => c.receipt).length,
  };
}

/** Every committed run export, oldest first by its folder's time stamp. */
export function runDirs(runsDir = resolveProjectPath("eval/runs")): string[] {
  const stamp = (d: string) => d.match(/(\d{8}T\d{6}Z)$/)?.[1] ?? d;
  return readdirSync(runsDir)
    .filter((d) => existsSync(join(runsDir, d, "run-meta.json")))
    .sort((a, b) => stamp(a).localeCompare(stamp(b)) || a.localeCompare(b))
    .map((d) => join(runsDir, d));
}

const served = (c: LoggedCall) =>
  c.receipt?.route.model ?? (c.provider === "ollama" ? `${c.traceModel ?? "Lightning"} (Ollama backup)` : "");
const checkText = (c: LoggedCall) => {
  if (c.receipt)
    return c.receipt.checked === "valid_pinned"
      ? "signature valid, key pinned"
      : "signature valid, key from the receipt";
  if (c.provider === "ollama") return "no receipt: the Ollama backup answered";
  return c.status === "ok" ? "no receipt recorded" : `no receipt: the call ended with status ${c.status}`;
};
const secs = (ms?: number) => (typeof ms === "number" ? (ms / 1000).toFixed(1) : "");

const page = (title: string, body: string, home: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${esc(title)}</title>
    <link rel="stylesheet" href="receipts.css" />
  </head>
  <body>
    <main>
      <p class="banner" role="note"><strong>${esc(BANNER)}</strong> Every row below is read from files committed in the
      <a href="${REPO_URL}">repository</a> (<code>eval/runs/</code>), and every signature was checked when this page was built.</p>
${body}
      <footer>
        <a href="${home}">Site home</a> · <a href="index.html">Receipt log</a> · <a href="../runs/index.html">Recorded runs</a> ·
        <a href="${REPO_URL}">Source on GitHub</a> (Apache-2.0)
      </footer>
    </main>
  </body>
</html>
`;

const table = (
  caption: string,
  head: string[],
  rows: string[][],
) => `      <div class="wrap" role="region" aria-label="${esc(caption)}" tabindex="0">
        <table>
          <caption>${esc(caption)}</caption>
          <thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>
${rows.map((r) => `            <tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")}
          </tbody>
        </table>
      </div>`;

const HOW = `<p>Each signature is Ed25519 over the receipt body in <code>receipts.jsonl.gz</code>, checked with the same code as <code>npm run evidence:verify</code>. No key is pinned for the site build, so the check uses the key carried in each receipt: it shows the receipt was not changed after signing, not who signed it. The build stops if a receipt is missing, does not verify, or names a different model from the trace.</p>`;

export function renderRunLog(log: RunLog): string {
  const rows = log.calls.map((c) => [
    esc(c.caseId),
    String(c.seq),
    esc(STEP_NAMES[c.agent] ?? c.agent),
    `<code>${esc(c.requested ?? "")}</code>`,
    `<code>${esc(c.traceModel ?? "")}</code>`,
    `<code>${esc(served(c))}</code>`,
    c.receipt ? `<code>${esc(c.receipt.id)}</code>` : "",
    esc(c.receipt?.app ?? ""),
    secs(c.latencyMs),
    c.tokensIn === undefined ? "" : `${c.tokensIn} / ${c.tokensOut ?? ""}`,
    esc(checkText(c)),
  ]);
  const body = `      <h1>Receipt log: <code>${esc(log.runId)}</code></h1>
      <p>${log.calls.length} model calls; ${log.verified} with a receipt that verified when this page was built.${log.policyVersion === undefined ? "" : ` Policy version ${log.policyVersion}.`}${log.startedAt ? ` Started ${esc(log.startedAt)}.` : ""}</p>
      ${HOW}
${table(
  "Every model call of the run, in case and step order",
  [
    "Case",
    "Step no.",
    "Step",
    "Mode asked for",
    "Model in the trace",
    "Model the receipt names",
    "Receipt id",
    "App identity",
    "Seconds",
    "Tokens in / out",
    "Check",
  ],
  rows,
)}
      <p>Check it yourself: clone the repository and run <code>npm run evidence:verify -- eval/runs/${esc(log.runId)}</code>.</p>`;
  return page(`Receipt log: ${log.runId}`, body, "../index.html");
}

export function renderLogIndex(logs: RunLog[]): string {
  const total = logs.reduce((t, l) => t + l.calls.length, 0);
  const verified = logs.reduce((t, l) => t + l.verified, 0);
  const rows = logs.map((l) => [
    `<a href="${esc(l.runId)}.html"><code>${esc(l.runId)}</code></a>`,
    l.calls.length === 0 ? "none (a baseline without a model)" : String(l.calls.length),
    String(l.verified),
    String(l.calls.filter((c) => c.provider === "ollama").length),
    String(l.calls.filter((c) => !c.receipt && c.provider !== "ollama").length),
  ]);
  const body = `      <h1>Receipt log</h1>
      <p>Every model call in the ${logs.length} committed run exports: the step, the mode the desk asked Nightshift for, the Nemotron model that served it, and its signed receipt. ${verified.toLocaleString("en-US")} receipts verified when these pages were built, across ${total.toLocaleString("en-US")} model calls; a call without a receipt is either an answer from the Ollama backup or a call that failed before any answer.</p>
      ${HOW}
${table("The committed runs", ["Run", "Model calls", "Receipts verified", "Ollama backup answers (no receipt)", "Failed calls (no answer)"], rows)}`;
  return page("Receipt log", body, "../index.html");
}

/** Build the receipt log into `outDir` (site/receipts/ in the built site). Returns the files written. */
export function buildReceiptLog(outDir: string, opts: ReceiptLogOptions = {}): string[] {
  const logs = runDirs(opts.runsDir ? resolve(opts.runsDir) : undefined).map((d) => loadRunLog(d, opts));
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const log of logs) {
    writeFileSync(join(outDir, `${log.runId}.html`), renderRunLog(log));
    written.push(`${log.runId}.html`);
  }
  writeFileSync(join(outDir, "index.html"), renderLogIndex(logs));
  writeFileSync(join(outDir, "receipts.css"), RUNS_CSS);
  written.push("index.html", "receipts.css");
  return written;
}

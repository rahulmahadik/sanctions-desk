/**
 * The receipt log of the static site (site/receipts/): every model call of every committed run export, one page per
 * run. It reads only eval/runs/<run-id>/ and shows ids, steps, models, timings and token counts, never prompt text.
 *
 * The build throws RecordedRunError when a receipt is missing, does not verify, disagrees with the trace, or the run
 * fails `npm run evidence:verify`, so the published log only shows receipts that check out.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { problemsIn, verifyExportedRun } from "./evidence.js";
import { receiptFigure, receiptSentence } from "./receipt-figure.js";
import {
  BANNER,
  type CheckedCall,
  checkCalls,
  pinnedKeys,
  RecordedRunError,
  readRunFiles,
  type TraceEvent,
} from "./runs-site.js";
import { esc, pageOf, REPO_URL, tableOf } from "./site-chrome.js";

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
  /** Pinned receipt keys. By default the key the configuration pins, so a receipt signed by another key fails. */
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
    const checked = checkCalls(sorted, envelopes, opts.trustedKeys ?? pinnedKeys(), `${runId} ${caseId}`);
    checked.forEach((c, i) => {
      const provider = (answers[i] as TraceEvent).provider;
      // The rules stand-in of a baseline variant answers in the same event shape, but it is not a model call.
      if (provider !== "fallback-rules") calls.push({ ...c, caseId, provider });
    });
  }
  const run = verifyExportedRun(runDir, [...(opts.trustedKeys ?? pinnedKeys())]);
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
  if (c.provider === "ollama") return "no receipt by design: the local Ollama backup answered";
  return c.status === "ok" ? "no receipt recorded" : `no receipt: the call ended with status ${c.status}`;
};
const secs = (ms?: number) => (typeof ms === "number" ? (ms / 1000).toFixed(1) : "");

const page = (title: string, description: string, body: string) =>
  pageOf(
    { title, description, depth: 1, current: "receipts/index.html", bodyClass: "page-receipts" },
    `      <p class="banner" role="note"><strong>${esc(BANNER)}</strong> Every row below is read from files committed in the
      <a href="${REPO_URL}">repository</a> (<code>eval/runs/</code>), and every signature was checked when this page was built.</p>
${body}`,
  );

const table = tableOf;

/** A model's name as text, coloured by the Nemotron model that answered (the same colours as the diagrams). */
const modelCell = (c: LoggedCall, text: string) =>
  text ? `<code class="model-${modelKind(c)}">${esc(text)}</code>` : "";

const HOW = `<p>Each signature is Ed25519 over the receipt body in <code>receipts.jsonl.gz</code>, checked with the same code as <code>npm run evidence:verify</code>. The receipt key of the Nightshift runtime is pinned in <code>config/default.json</code>: a receipt counts only if it is signed by that key, so it shows both that the receipt was not changed and that this runtime signed it. The build stops if a receipt is signed by another key, if a receipt is missing, does not verify, or names a different model from the trace.</p>`;

/** Who answered the run's calls, before the full list: a blank receipt id is the Ollama backup or a call with no answer. */
function summary(log: RunLog): string {
  const n = { lightning: 0, ultra: 0, ollama: 0, none: 0 };
  for (const c of log.calls) n[modelKind(c)] += 1;
  return `${table(
    "Who answered, in this run",
    ["Answered by", "Calls", "Receipt"],
    [
      [
        `<span class="model-lightning">Nemotron 3.5 Lightning through Nightshift (laptop)</span>`,
        String(n.lightning),
        "signed, checked against the pinned key",
      ],
      [
        `<span class="model-ultra">Nemotron 3 Ultra through Nightshift (cloud)</span>`,
        String(n.ultra),
        "signed, checked against the pinned key",
      ],
      [
        `<span class="model-ollama">Local Ollama backup (Lightning)</span>`,
        String(n.ollama),
        "none, by design: it does not go through Nightshift",
      ],
      ["No answer (the call failed)", String(n.none), "none"],
    ],
    { num: [1] },
  )}
      <p>In the full list below, a row without a receipt id is an answer from the local Ollama backup or a call that ended without an answer; its last column says which.</p>`;
}

export function renderRunLog(log: RunLog): string {
  const rows = log.calls.map((c) => [
    esc(c.caseId),
    String(c.seq),
    esc(STEP_NAMES[c.agent] ?? c.agent),
    `<code>${esc(c.requested ?? "")}</code>`,
    modelCell(c, c.traceModel ?? ""),
    modelCell(c, served(c)),
    c.receipt ? `<code>${esc(c.receipt.id)}</code>` : "",
    esc(c.receipt?.app ?? ""),
    secs(c.latencyMs),
    c.tokensIn === undefined ? "" : `${c.tokensIn} / ${c.tokensOut ?? ""}`,
    esc(checkText(c)),
  ]);
  const body = `      <div class="page-head">
      <p class="crumbs"><a href="index.html">Receipt log</a> / <code>${esc(log.runId)}</code></p>
      <h1>Receipt log: <code>${esc(log.runId)}</code></h1>
      <p>${log.calls.length} model calls; ${log.verified} with a receipt that verified when this page was built.${log.policyVersion === undefined ? "" : ` Policy version ${log.policyVersion}.`}${log.startedAt ? ` Started ${esc(log.startedAt)}.` : ""}</p>
      </div>
      ${HOW}
${summary(log)}
      <h2>Full list</h2>
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
  { num: [1, 8, 9], id: [6] },
)}
      <p>Check it yourself: clone the repository and run <code>npm run evidence:verify -- eval/runs/${esc(log.runId)}</code>.</p>`;
  return page(
    `Receipt log: ${log.runId}`,
    `Every model call of the recorded run ${log.runId}, with the mode asked for, the Nemotron model that served it and its signed receipt.`,
    body,
  );
}

/** Which Nemotron model answered a call: Lightning or Ultra through Nightshift, the Ollama backup, or none. */
export function modelKind(c: LoggedCall): "lightning" | "ultra" | "ollama" | "none" {
  if (c.provider === "ollama" && c.traceModel) return "ollama";
  const m = c.receipt?.route.model ?? (c.receipt ? c.traceModel : undefined) ?? "";
  if (/ultra/i.test(m)) return "ultra";
  if (/lightning/i.test(m)) return "lightning";
  return "none";
}

/** One line on Nightshift and Nemotron, for the top of the log. */
export const NIGHTSHIFT_LINE =
  "Meterless Nightshift routes each model call the desk makes: Nemotron 3.5 Lightning answers on the analyst's laptop and Nemotron 3 Ultra in the cloud. Every answer Nightshift serves is signed, and the desk pins the key it must be signed with.";

/** The one line under the table for the runs that made no model call (the baselines: rules, name matching, escalate everything). */
export const baselinesLine = (n: number) =>
  `Baselines without a model (rules, name matching, escalate everything): no model calls, so no receipts — ${n} ${n === 1 ? "run" : "runs"}.`;

/** The index page. `figure` is the canonical receipt sentence (tools/lib/receipt-figure.ts), when the log is the committed one. */
export function renderLogIndex(logs: RunLog[], figure?: string): string {
  const total = logs.reduce((t, l) => t + l.calls.length, 0);
  const verified = logs.reduce((t, l) => t + l.verified, 0);
  const count = (l: RunLog, k: ReturnType<typeof modelKind>) => l.calls.filter((c) => modelKind(c) === k).length;
  // The baselines made no model call, so their rows would be all zero; they are counted in one line instead.
  const withCalls = logs.filter((l) => l.calls.length > 0);
  const rows = withCalls.map((l) => [
    `<a href="${esc(l.runId)}.html"><code>${esc(l.runId)}</code></a>`,
    String(l.calls.length),
    String(l.verified),
    String(count(l, "lightning")),
    String(count(l, "ultra")),
    String(count(l, "ollama")),
    String(l.calls.filter((c) => !c.receipt && c.provider !== "ollama").length),
  ]);
  const body = `      <div class="page-head">
      <p class="crumbs"><a href="../index.html">Sanctions Desk</a> / Receipt log</p>
      <h1>Receipt log</h1>
      <p class="lead"><strong>${esc(NIGHTSHIFT_LINE)}</strong></p>
      </div>
      ${figure ? `<p class="measure">${esc(figure)}.</p>` : ""}
      <p class="measure">Every model call in the ${logs.length} committed run exports: the step, the mode the desk asked Nightshift for, the Nemotron model that served it, and its signed receipt. ${verified.toLocaleString("en-US")} receipts verified when these pages were built, across ${total.toLocaleString("en-US")} model calls; a call without a receipt is either an answer from the Ollama backup or a call that failed before any answer.</p>
      ${HOW}
${table(
  "The committed runs",
  [
    "Run",
    "Model calls",
    "Receipts verified",
    "Lightning, laptop (receipt)",
    "Ultra, cloud (receipt)",
    "Ollama backup (no receipt)",
    "Failed calls (no answer)",
  ],
  rows,
  { num: [1, 2, 3, 4, 5, 6], id: [0] },
)}
      <p class="summary-line">${esc(baselinesLine(logs.length - withCalls.length))}</p>`;
  return page(
    "Receipt log",
    "Every model call in the committed Sanctions Desk runs, with the Nemotron model that served it and its signed receipt, each signature checked when the site was built.",
    body,
  );
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
  // The committed log quotes the one receipt figure, and must agree with it.
  let figure: string | undefined;
  if (!opts.runsDir) {
    const f = receiptFigure(resolveProjectPath("."));
    const kinds = logs.flatMap((l) => l.calls.map(modelKind));
    const signed = logs.reduce((t, l) => t + l.verified, 0);
    const ollama = kinds.filter((k) => k === "ollama").length;
    if (logs.length !== f.runs || signed !== f.verified || ollama !== f.ollama)
      throw new RecordedRunError(
        `the receipt log (${logs.length} runs, ${signed} receipts, ${ollama} backup answers) disagrees with eval/receipt-stats.json and eval/receipts-check.json (${f.runs}, ${f.verified}, ${f.ollama}): run npm run receipts:check and npm run receipt:stats`,
      );
    figure = receiptSentence(f);
  }
  writeFileSync(join(outDir, "index.html"), renderLogIndex(logs, figure));
  written.push("index.html");
  return written;
}

/**
 * The one receipt figure the README, docs/NEMOTRON.md, the site and the deck quote: how many exported runs, how many
 * model calls in them, and how those calls split: answers Nightshift served, each with a signed receipt verified
 * against the pinned key; answers from the local Ollama backup, which has no receipt by design; and failed calls that
 * returned no answer. Read from eval/receipts-check.json (npm run receipts:check), eval/receipt-stats.json
 * (npm run receipt:stats) and the exported traces in eval/runs (tracked by git); it throws when the files disagree,
 * so a stale file cannot put two different figures on the page.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { RUN_GROUP_ORDER } from "./run-groups.js";

export interface ReceiptCheck {
  receipts: number;
  from_runs: number;
  from_studies: number;
  valid_pinned: number;
  groups: { runs: { folders: number } };
}
export interface StatsGroup {
  id: string;
  runs: number;
  rows: Array<{ step: string; model: string; calls: number; receipts_verified: number }>;
}

export interface ReceiptFigure {
  /** Exported runs in eval/runs. */
  runs: number;
  /** Model answers in those runs (Nightshift and the Ollama backup). */
  answers: number;
  /** Model calls that failed and returned no answer (every provider failed), from the exported traces. */
  failed: number;
  /** All model calls: answers plus failed calls. */
  calls: number;
  /** Answers Nightshift served; each has a signed receipt. */
  nightshift: number;
  /** Of those, receipts verified against the pinned key. */
  verified: number;
  /** Answers from the local Ollama backup (no receipt by design). */
  ollama: number;
  /** Signed receipts of the small studies in eval/studies, all verified. */
  studies: number;
  /** Per model over the exported runs: Lightning and Ultra through Nightshift, and the Ollama backup. */
  byModel: { lightning: number; ultra: number; ollama: number };
}

const isOllama = (model: string) => /Ollama/.test(model);

/** The figure from the two committed files (the exported-run groups of eval/receipt-stats.json only). */
export function receiptFigureFrom(
  check: ReceiptCheck,
  groups: readonly StatsGroup[],
  failed: { runs: number; calls: number },
): ReceiptFigure {
  if (check.valid_pinned !== check.receipts)
    throw new Error("eval/receipts-check.json has receipts that do not verify against the pinned key");
  const runGroups = groups.filter((g) => (RUN_GROUP_ORDER as readonly string[]).includes(g.id));
  const rows = runGroups.flatMap((g) => g.rows);
  const sum = (pick: (r: StatsGroup["rows"][number]) => number) => rows.reduce((t, r) => t + pick(r), 0);
  const ollama = sum((r) => (isOllama(r.model) ? r.calls : 0));
  const nightshift = sum((r) => (isOllama(r.model) ? 0 : r.calls));
  const verified = sum((r) => r.receipts_verified);
  const runs = runGroups.reduce((t, g) => t + g.runs, 0);
  if (
    nightshift !== check.from_runs ||
    verified !== nightshift ||
    runs !== check.groups.runs.folders ||
    failed.runs !== runs
  )
    throw new Error(
      `eval/receipt-stats.json (${runs} runs, ${nightshift} Nightshift answers, ${verified} verified) and eval/receipts-check.json (${check.groups.runs.folders} runs, ${check.from_runs} receipts) and the exported traces (${failed.runs} runs) disagree: run npm run receipts:check and npm run receipt:stats`,
    );
  return {
    runs,
    answers: nightshift + ollama,
    failed: failed.calls,
    calls: nightshift + ollama + failed.calls,
    nightshift,
    verified,
    ollama,
    studies: check.from_studies,
    byModel: {
      lightning: sum((r) => (!isOllama(r.model) && /Lightning/.test(r.model) ? r.calls : 0)),
      ultra: sum((r) => (/Ultra/.test(r.model) ? r.calls : 0)),
      ollama,
    },
  };
}

/** The steps whose model calls are counted (the trace's agent names). */
const MODEL_STEPS = new Set(["policy_guard", "screener", "decision", "critic", "challenger"]);

/**
 * Model calls that failed with no answer, over the exported runs tracked by git (the run folders with a
 * receipts.jsonl.gz, as npm run receipt:stats reads them): a model_answer event of a model step with no provider and no
 * serving model. The rules stand-in of a baseline variant is not a model call and is not counted.
 */
export function failedModelCalls(root: string): { runs: number; calls: number } {
  const dirs = execFileSync("git", ["ls-files", "-z", "--", "eval/runs"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.endsWith("/receipts.jsonl.gz"))
    .map((f) => join(root, "eval/runs", f.split("/")[2] as string))
    .filter((d) => existsSync(join(d, "trace.jsonl.gz")));
  let calls = 0;
  for (const d of dirs)
    for (const line of gunzipSync(readFileSync(join(d, "trace.jsonl.gz")))
      .toString("utf8")
      .split("\n")) {
      if (!line.includes('"model_answer"')) continue;
      const e = JSON.parse(line) as { agent: string; action: string; provider?: string; model_used?: string };
      if (e.action === "model_answer" && MODEL_STEPS.has(e.agent) && !e.provider && !e.model_used) calls += 1;
    }
  return { runs: dirs.length, calls };
}

/** The figure from the committed files under `root`. */
export function receiptFigure(root: string): ReceiptFigure {
  const read = <T>(rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
  return receiptFigureFrom(
    read<ReceiptCheck>("eval/receipts-check.json"),
    read<{ groups: StatsGroup[] }>("eval/receipt-stats.json").groups,
    failedModelCalls(root),
  );
}

const n = (x: number) => x.toLocaleString("en-US");

/**
 * The canonical breakdown, used everywhere the receipts are counted: total model calls = receipted Nightshift answers
 * + Ollama backup answers + failed calls. No final full stop, so a caller can bold or link it.
 */
export function receiptSentence(f: ReceiptFigure): string {
  const each = f.verified === f.nightshift ? "each" : `${n(f.verified)} of them`;
  return `In the ${f.runs} exported runs the desk made ${n(f.calls)} model calls. ${n(f.nightshift)} were Nightshift answers, ${each} with a signed receipt verified against the pinned key. Another ${n(f.ollama)} came from the local Ollama backup, which has no receipt by design. The other ${n(f.failed)} failed and returned no answer. The small studies add ${n(f.studies)} more signed receipts, all verified`;
}

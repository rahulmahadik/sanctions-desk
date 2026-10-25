/**
 * The one receipt figure the README, docs/NEMOTRON.md, the site and the deck quote: how many exported runs, how many
 * model answers in them, how many came from Nightshift with a signed receipt verified against the pinned key, and how
 * many came from the local Ollama backup, which has no receipt by design. Read from eval/receipts-check.json
 * (npm run receipts:check) and eval/receipt-stats.json (npm run receipt:stats); it throws when the two disagree, so a
 * stale file cannot put two different figures on the page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
export function receiptFigureFrom(check: ReceiptCheck, groups: readonly StatsGroup[]): ReceiptFigure {
  if (check.valid_pinned !== check.receipts)
    throw new Error("eval/receipts-check.json has receipts that do not verify against the pinned key");
  const runGroups = groups.filter((g) => (RUN_GROUP_ORDER as readonly string[]).includes(g.id));
  const rows = runGroups.flatMap((g) => g.rows);
  const sum = (pick: (r: StatsGroup["rows"][number]) => number) => rows.reduce((t, r) => t + pick(r), 0);
  const ollama = sum((r) => (isOllama(r.model) ? r.calls : 0));
  const nightshift = sum((r) => (isOllama(r.model) ? 0 : r.calls));
  const verified = sum((r) => r.receipts_verified);
  const runs = runGroups.reduce((t, g) => t + g.runs, 0);
  if (nightshift !== check.from_runs || verified !== nightshift || runs !== check.groups.runs.folders)
    throw new Error(
      `eval/receipt-stats.json (${runs} runs, ${nightshift} Nightshift answers, ${verified} verified) and eval/receipts-check.json (${check.groups.runs.folders} runs, ${check.from_runs} receipts) disagree: run npm run receipts:check and npm run receipt:stats`,
    );
  return {
    runs,
    answers: nightshift + ollama,
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

/** The figure from the committed files under `root`. */
export function receiptFigure(root: string): ReceiptFigure {
  const read = <T>(rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
  return receiptFigureFrom(
    read<ReceiptCheck>("eval/receipts-check.json"),
    read<{ groups: StatsGroup[] }>("eval/receipt-stats.json").groups,
  );
}

const n = (x: number) => x.toLocaleString("en-US");

/** The canonical sentence, one line, used everywhere the receipts are counted. */
export function receiptSentence(f: ReceiptFigure): string {
  const all = f.verified === f.nightshift ? "all" : `${n(f.verified)} of them`;
  return `Every Nightshift answer has a signed receipt: in the ${f.runs} exported runs, ${n(f.nightshift)} of ${n(f.answers)} model answers came from Nightshift, ${all} verified against the pinned key; the other ${n(f.ollama)} came from the local Ollama backup, which has no receipt by design. The small studies add ${n(f.studies)} more signed receipts, all verified`;
}

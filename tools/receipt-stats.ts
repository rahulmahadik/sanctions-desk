/**
 * Statistics of the model calls, per step and per model that served them, from the traces and the signed receipts:
 * calls, receipts that verify, median and p95 latency, median tokens in and out, and the fallbacks (answers from the
 * Ollama backup, and cloud answers set aside for citing more than 8 facts). The recorded runs (eval/runs) and the
 * labelled small runs of 24 Oct 2026 (logs/, kept on this machine) are reported separately and never added together.
 *
 *   npm run receipt:stats              # writes eval/receipt-stats.json and the table block in docs/NEMOTRON.md
 *   npm run receipt:stats -- --check   # exits 1 if either would change
 *
 * When logs/ holds no labelled run (a fresh clone), the labelled groups already in eval/receipt-stats.json are kept.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig, median, percentile, resolveProjectPath, verifyReceipt } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";

interface Event {
  run_id?: string;
  agent: string;
  action: string;
  status?: string;
  provider?: string;
  model_used?: string;
  latency_ms?: number | string;
  tokens_in?: number | string;
  tokens_out?: number | string;
  output_summary?: string;
  receipt?: { receipt_id?: string };
}

interface Row {
  step: string;
  model: string;
  calls: number;
  receipts_verified: number;
  latency_s: { median: number; p95: number };
  tokens_in_median: number;
  tokens_out_median: number;
}

interface Group {
  id: string;
  label: string;
  runs: number;
  rows: Row[];
  /** Per step: answers from the Ollama backup (no receipt), and cloud answers set aside for citing more than 8 facts. */
  fallbacks: Record<string, { backup_answers: number; fact_limit_rejections: number }>;
  /** Every decision, critic and challenger answer from Nightshift, whichever model served it. */
  reasoning_latency_s: { median: number; p95: number; calls: number };
}

const check = process.argv.includes("--check");
const trusted = [...loadConfig().nightshift.receiptPublicKeys];
const STEP: Record<string, string> = {
  policy_guard: "Safety guard",
  screener: "Screener",
  decision: "Decision",
  critic: "Critic",
  challenger: "Challenger",
};
const ORDER = Object.keys(STEP);
const MODEL = (m: string, provider?: string): string =>
  provider === "ollama"
    ? "Ollama backup (Lightning, no receipt)"
    : /ultra/i.test(m)
      ? "Nemotron 3 Ultra 550B (cloud)"
      : /lightning/i.test(m)
        ? "Nemotron 3.5 Lightning 30B (local)"
        : m;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? Number.NaN));
const quantile = (xs: number[], q: number): number => percentile(xs, q * 100);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** One group's statistics from its model-answer events and a lookup of verified receipt ids. */
function summarise(id: string, label: string, runs: number, events: Event[], verified: Set<string>): Group {
  const cells = new Map<string, { lat: number[]; tin: number[]; tout: number[]; calls: number; ok: number }>();
  const fallbacks: Group["fallbacks"] = {};
  const reasoning: number[] = [];
  for (const e of events) {
    if (e.action !== "model_answer" || !STEP[e.agent]) continue;
    const step = STEP[e.agent] as string;
    const fb = fallbacks[step] ?? { backup_answers: 0, fact_limit_rejections: 0 };
    fallbacks[step] = fb;
    if (/Too big: expected array to have <=8 items/.test(e.output_summary ?? "")) fb.fact_limit_rejections += 1;
    // A call that failed before any answer, or the rules stand-in of a baseline variant (not a model).
    if (!e.provider || !e.model_used || e.provider === "fallback-rules") continue;
    if (e.provider === "ollama") fb.backup_answers += 1;
    const key = `${step}\u0000${MODEL(e.model_used, e.provider)}`;
    const c = cells.get(key) ?? { lat: [], tin: [], tout: [], calls: 0, ok: 0 };
    c.calls += 1;
    if (e.receipt?.receipt_id && verified.has(e.receipt.receipt_id)) c.ok += 1;
    if (Number.isFinite(num(e.latency_ms))) c.lat.push(num(e.latency_ms) / 1000);
    if (
      ["decision", "critic", "challenger"].includes(e.agent) &&
      e.provider === "nightshift" &&
      Number.isFinite(num(e.latency_ms))
    )
      reasoning.push(num(e.latency_ms) / 1000);
    if (Number.isFinite(num(e.tokens_in))) c.tin.push(num(e.tokens_in));
    if (Number.isFinite(num(e.tokens_out))) c.tout.push(num(e.tokens_out));
    cells.set(key, c);
  }
  const rows = [...cells]
    .map(([key, c]) => {
      const [step, model] = key.split("\u0000") as [string, string];
      return {
        step,
        model,
        calls: c.calls,
        receipts_verified: c.ok,
        latency_s: { median: round1(median(c.lat)), p95: round1(quantile(c.lat, 0.95)) },
        tokens_in_median: Math.round(median(c.tin)),
        tokens_out_median: Math.round(median(c.tout)),
      };
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(Object.keys(STEP).find((k) => STEP[k] === a.step) ?? "") -
          ORDER.indexOf(Object.keys(STEP).find((k) => STEP[k] === b.step) ?? "") || a.model.localeCompare(b.model),
    );
  const orderedFallbacks = Object.fromEntries(
    ORDER.map((k) => STEP[k] as string)
      .filter((s) => fallbacks[s])
      .map((s) => [s, fallbacks[s] as Group["fallbacks"][string]]),
  );
  return {
    id,
    label,
    runs,
    rows,
    fallbacks: orderedFallbacks,
    reasoning_latency_s: {
      median: round1(median(reasoning)),
      p95: round1(quantile(reasoning, 0.95)),
      calls: reasoning.length,
    },
  };
}

const lines = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

// ---- recorded runs ---------------------------------------------------------------------------------------------

const runsDir = resolveProjectPath("eval/runs");
const recordedRuns = readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "receipts.jsonl.gz")));
const recordedEvents: Event[] = [];
const recordedVerified = new Set<string>();
for (const d of recordedRuns) {
  for (const l of lines(gunzipSync(readFileSync(join(runsDir, d, "receipts.jsonl.gz"))).toString("utf8"))) {
    const env = JSON.parse(l) as { body?: { receipt?: { receipt_id?: string } } };
    const id = env.body?.receipt?.receipt_id;
    if (id && verifyReceipt(env, trusted).status.startsWith("valid")) recordedVerified.add(id);
  }
  for (const l of lines(gunzipSync(readFileSync(join(runsDir, d, "trace.jsonl.gz"))).toString("utf8")))
    recordedEvents.push(JSON.parse(l) as Event);
}
const groups: Group[] = [
  summarise(
    "recorded",
    `Recorded runs (${recordedRuns.length} exported runs in eval/runs)`,
    recordedRuns.length,
    recordedEvents,
    recordedVerified,
  ),
];

// ---- labelled small runs of 24 Oct 2026 (kept apart) -------------------------------------------------------------

const LABELLED: Array<[string, string, RegExp]> = [
  [
    "privacy-off",
    "Small test of an optional mode: privacy mode off (24 Oct 2026, not part of the recorded evaluation)",
    /^eval-(heldout4-)?privoff-/,
  ],
  [
    "privacy-on",
    "Small test of an optional mode: privacy mode on (24 Oct 2026, not part of the recorded evaluation)",
    /^eval-(heldout4-)?privon-/,
  ],
  [
    "model-choice",
    "Small study of model choice: decision, critic and challenger on Lightning (not part of the recorded evaluation)",
    /^eval-(heldout4-)?choice-/,
  ],
];
const outFile = resolveProjectPath("eval/receipt-stats.json");
const previous = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, "utf8")) as { groups: Group[] }) : undefined;
const logs = resolveProjectPath("logs");
const traceFiles = existsSync(logs) ? readdirSync(logs).filter((f) => /^trace-eval-.*\.jsonl$/.test(f)) : [];
for (const [id, label, pattern] of LABELLED) {
  const files = traceFiles.filter((f) => pattern.test(f.slice("trace-".length)));
  if (files.length === 0) {
    const kept = previous?.groups.find((g) => g.id === id);
    if (kept) groups.push(kept);
    continue;
  }
  const events = files.flatMap((f) => lines(readFileSync(join(logs, f), "utf8")).map((l) => JSON.parse(l) as Event));
  const verified = new Set<string>();
  for (const e of events) {
    const rid = e.action === "model_answer" ? e.receipt?.receipt_id : undefined;
    const file = rid ? join(logs, "receipts", `${rid}.json`) : "";
    if (
      rid &&
      existsSync(file) &&
      verifyReceipt(JSON.parse(readFileSync(file, "utf8")), trusted).status.startsWith("valid")
    )
      verified.add(rid);
  }
  groups.push(summarise(id, label, files.length, events, verified));
}

// ---- outputs --------------------------------------------------------------------------------------------------------

const json = `${JSON.stringify({ note: "Written by npm run receipt:stats; do not edit by hand.", groups }, null, 2)}\n`;
const table = (g: Group): string =>
  [
    `**${g.label}**`,
    "",
    "| Step | Model that served it | Calls | Receipts verified | Median s | p95 s | Median tokens in | Median tokens out |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...g.rows.map(
      (r) =>
        `| ${r.step} | ${r.model} | ${r.calls} | ${r.receipts_verified} | ${r.latency_s.median} | ${r.latency_s.p95} | ${r.tokens_in_median} | ${r.tokens_out_median} |`,
    ),
    "",
    `Fallbacks: ${
      Object.entries(g.fallbacks)
        .filter(([, f]) => f.backup_answers + f.fact_limit_rejections > 0)
        .map(
          ([s, f]) =>
            `${s}: ${f.backup_answers} answer(s) from the Ollama backup, ${f.fact_limit_rejections} answer(s) set aside for citing more than 8 facts`,
        )
        .join("; ") || "none"
    }.`,
  ].join("\n");
const block = groups.map(table).join("\n\n");
const docFile = resolveProjectPath("docs/NEMOTRON.md");
let changed = false;
if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== json) {
  changed = true;
  if (!check) writeFileSync(outFile, json);
}
if (existsSync(docFile)) {
  const doc = readFileSync(docFile, "utf8");
  const re = /(<!-- receipt-stats:start -->)[\s\S]*?(<!-- receipt-stats:end -->)/;
  if (re.test(doc)) {
    const next = formatMarkdown(doc.replace(re, `$1\n${block}\n$2`), docFile);
    if (next !== doc) {
      changed = true;
      if (!check) writeFileSync(docFile, next);
    }
  }
}
if (check && changed) {
  console.error("receipt statistics are out of date: run npm run receipt:stats");
  process.exit(1);
}
console.log(
  `${check ? "checked" : "wrote"} receipt statistics: ${groups.map((g) => `${g.id} (${g.rows.reduce((n, r) => n + r.calls, 0)} calls)`).join(", ")}`,
);

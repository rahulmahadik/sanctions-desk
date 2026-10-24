/**
 * Small study of model choice, not part of the recorded evaluation: the same 20 cases (held-out v4 and 8 of the 70
 * exam cases) with the decision, critic and challenger on Nemotron 3 Ultra in the cloud (the default; the privacy-mode-
 * off run of 24 Oct 2026) and on Nemotron 3.5 Lightning on the laptop (the `lightning` variant). One live run each.
 *
 *   npm run study:model-choice          # writes eval/model-choice.json, logs/model-choice/STUDY.md and the block in docs/NEMOTRON.md
 *   npm run study:model-choice -- --check
 *
 * It reads the result files in logs/privacy-test and logs/model-choice (kept on this machine) and the per-group call
 * statistics in eval/receipt-stats.json (npm run receipt:stats). Without the logs (a fresh clone) the committed
 * eval/model-choice.json is used as it is.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";

interface Case {
  case_id: string;
  latency_s?: number;
  expected: string;
  must_not: string[];
  got: string;
}
interface Result {
  exam?: string;
  system?: string;
  variant: string;
  cases: Case[];
}
interface Arm {
  label: string;
  short: string;
  /** Median wall time per case, retries and fallbacks included, in seconds. */
  median_case_s: number;
  /** Cases with no usable decision (ERROR). */
  errors: number;
  cases: number;
  risk_cases: number;
  wrong_closes: number;
  clear_cases: number;
  clears_made: number;
  outcomes_identical_to_default: number;
  reasoning_calls: number;
  reasoning_receipts_verified: number;
  reasoning_median_latency_s: number;
  fact_limit_rejections: number;
  backup_answers: number;
  served_by: Record<string, number>;
}

const check = process.argv.includes("--check");
const outFile = resolveProjectPath("eval/model-choice.json");
const readResults = (dir: string, system: string): Result[] => {
  const d = resolveProjectPath(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && f.includes(`-${system}-`))
    .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as Result)
    .filter((r) => Array.isArray(r.cases));
};
const ultra = readResults("logs/privacy-test", "privoff");
const lightning = readResults("logs/model-choice", "choice");

const REASONING = ["Decision", "Critic", "Challenger"];
interface StatsGroup {
  id: string;
  rows: Array<{ step: string; model: string; calls: number; receipts_verified: number; latency_s: { median: number } }>;
  fallbacks: Record<string, { backup_answers: number; fact_limit_rejections: number }>;
  reasoning_latency_s: { median: number; p95: number; calls: number };
}
const stats = JSON.parse(readFileSync(resolveProjectPath("eval/receipt-stats.json"), "utf8")) as {
  groups: StatsGroup[];
};

function arm(label: string, short: string, results: Result[], statsId: string, baseline: Map<string, string>): Arm {
  const cases = results.flatMap((r) => r.cases);
  const risk = cases.filter((c) => c.must_not.includes("CLOSE_FALSE_POSITIVE"));
  const clear = cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE");
  const g = stats.groups.find((x) => x.id === statsId);
  const rows = (g?.rows ?? []).filter((r) => REASONING.includes(r.step) && !/Ollama/.test(r.model));
  const served: Record<string, number> = {};
  for (const r of rows) served[r.model] = (served[r.model] ?? 0) + r.calls;
  const times = cases.flatMap((c) => (typeof c.latency_s === "number" ? [c.latency_s] : [])).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const medianCase =
    times.length === 0
      ? 0
      : times.length % 2
        ? (times[mid] as number)
        : ((times[mid - 1] as number) + (times[mid] as number)) / 2;
  return {
    label,
    short,
    median_case_s: Math.round(medianCase),
    errors: cases.filter((c) => c.got === "ERROR").length,
    cases: cases.length,
    risk_cases: risk.length,
    wrong_closes: risk.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length,
    clear_cases: clear.length,
    clears_made: clear.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length,
    outcomes_identical_to_default: cases.filter((c) => baseline.get(c.case_id) === c.got).length,
    reasoning_calls: rows.reduce((n, r) => n + r.calls, 0),
    reasoning_receipts_verified: rows.reduce((n, r) => n + r.receipts_verified, 0),
    reasoning_median_latency_s: g?.reasoning_latency_s.median ?? 0,
    fact_limit_rejections: REASONING.reduce((n, s) => n + (g?.fallbacks[s]?.fact_limit_rejections ?? 0), 0),
    backup_answers: REASONING.reduce((n, s) => n + (g?.fallbacks[s]?.backup_answers ?? 0), 0),
    served_by: served,
  };
}

let study: { label: string; note: string; arms: Arm[] } | undefined;
if (ultra.length > 0 && lightning.length > 0) {
  const baseline = new Map(ultra.flatMap((r) => r.cases).map((c) => [c.case_id, c.got]));
  study = {
    label: "Small study of model choice, not part of the recorded evaluation",
    note: "Held-out v4 (12 cases) and 8 of the 70 exam cases (4 risks, 4 clears), one live run per arm on 24 Oct 2026, Nightshift warmed up and not restarted. The default arm is the privacy-mode-off run of the same day.",
    arms: [
      arm(
        "Decision, critic and challenger on Nemotron 3 Ultra (cloud), the default",
        "Ultra arm (default)",
        ultra,
        "privacy-off",
        baseline,
      ),
      arm(
        "Decision, critic and challenger on Nemotron 3.5 Lightning (local)",
        "Lightning arm",
        lightning,
        "model-choice",
        baseline,
      ),
    ],
  };
} else if (existsSync(outFile)) {
  study = JSON.parse(readFileSync(outFile, "utf8"));
}
if (!study) throw new Error("no study results: run the two arms first (see the header)");

const table = [
  `**${study.label}.** ${study.note}`,
  "",
  "| Arm | Risk cases wrongly closed | Clears made | Outcomes identical to the default | Errors | Reasoning calls (receipts verified) | Median s per reasoning call | Median s per case | Answers set aside for more than 8 facts | Backup answers (no receipt) |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...study.arms.map(
    (a) =>
      `| ${a.label} | ${a.wrong_closes} of ${a.risk_cases} | ${a.clears_made} of ${a.clear_cases} | ${a.outcomes_identical_to_default} of ${a.cases} | ${a.errors} | ${a.reasoning_calls} (${a.reasoning_receipts_verified}) | ${a.reasoning_median_latency_s} | ${a.median_case_s} | ${a.fact_limit_rejections} | ${a.backup_answers} |`,
  ),
  "",
  `Which model served the reasoning calls (receipts): ${study.arms
    .map(
      (a) =>
        `${a.short}: ${Object.entries(a.served_by)
          .map(([m, n]) => `${m} ${n}`)
          .join(", ")}`,
    )
    .join("; ")}.`,
].join("\n");

const json = `${JSON.stringify(study, null, 2)}\n`;
let changed = !existsSync(outFile) || readFileSync(outFile, "utf8") !== json;
if (changed && !check) writeFileSync(outFile, json);
const logDir = resolveProjectPath("logs/model-choice");
if (!check && existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "STUDY.md"), `# ${study.label}\n\n${table}\n`);
}
const docFile = resolveProjectPath("docs/NEMOTRON.md");
if (existsSync(docFile)) {
  const doc = readFileSync(docFile, "utf8");
  const re = /(<!-- model-choice:start -->)[\s\S]*?(<!-- model-choice:end -->)/;
  if (re.test(doc)) {
    const next = formatMarkdown(doc.replace(re, `$1\n${table}\n$2`), docFile);
    if (next !== doc) {
      changed = true;
      if (!check) writeFileSync(docFile, next);
    }
  }
}
if (check && changed) {
  console.error("the model-choice study summary is out of date: run npm run study:model-choice");
  process.exit(1);
}
console.log(
  `${check ? "checked" : "wrote"} the model-choice study: ${study.arms.map((a) => `${a.wrong_closes} of ${a.risk_cases} wrong closes`).join(" vs ")}`,
);

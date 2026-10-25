/**
 * One source of truth for the counts that appear in prose. Marked values in README.md and docs/*.md, written as
 * <!--fact:name-->value<!--/fact-->, are replaced with the value computed here from the committed data.
 *
 *   npm run readme:refresh                    # rewrite the marked values (and the data-harness counts and Nemotron scorecard)
 *   npm run readme:refresh -- --check         # fail if any marked value is out of date (used in CI)
 *   npm run readme:refresh -- --count-tests   # also run the test suite and record how many tests it has
 *
 * The badge line between <!-- badges:start --> and <!-- badges:end --> is written here too. The CI badge is GitHub's
 * own (live status, also on a private repository); the others are static, from package.json, so --check catches drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { USL_ROLES, USL_STEP_ROLES, ZETARIS_ROLES } from "@sanctions-desk/zetaris";
import { receiptFigure, receiptSentence } from "./lib/receipt-figure.js";
import { receiptsLine } from "./lib/receipts-scan.js";

const read = (p: string) => JSON.parse(readFileSync(resolveProjectPath(p), "utf8"));
const exam = read("eval/cases/exam.json") as { cases: { group: string; kind?: string }[] };
const heldout = read("eval/cases/heldout.json") as { cases: { expected: string }[] };
const edge = read("eval/edge-cases.json") as { edge_cases: unknown[] };
const factsFile = resolveProjectPath("eval/facts.json");
const saved = existsSync(factsFile) ? (JSON.parse(readFileSync(factsFile, "utf8")) as { tests?: number }) : {};

// A refresh also rewrites the data-harness counts and the Nemotron scorecard; with --check, CI checks them in their
// own steps.
if (!process.argv.includes("--check")) {
  execFileSync("npx", ["tsx", resolveProjectPath("tools/zetaris-harness.ts")], { stdio: "inherit" });
  execFileSync("npx", ["tsx", resolveProjectPath("tools/nemotron-scorecard.ts")], { stdio: "inherit" });
}
const harness = read("eval/zetaris-harness.json") as { agent_files: { scanned: number; naming_any_source: number } };

if (process.argv.includes("--count-tests")) {
  const out = join(mkdtempSync(join(tmpdir(), "tests-")), "vitest.json");
  try {
    execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], { stdio: "ignore" });
  } catch {
    // a failing test still writes the report; the count is read from it
  }
  const report = JSON.parse(readFileSync(out, "utf8")) as { numTotalTests: number; numFailedTests: number };
  if (report.numFailedTests > 0) throw new Error(`${report.numFailedTests} tests fail; not recording a count`);
  saved.tests = report.numTotalTests;
  writeFileSync(factsFile, `${JSON.stringify(saved, null, 2)}\n`);
}

interface ReceiptGroup {
  receipts: number;
  folders: number;
  with_added_memory: number;
  cross_check: Record<string, number>;
  cross_check_warnings: Record<string, number>;
}
const receipts = read("eval/receipts-check.json") as {
  receipts: number;
  from_runs: number;
  from_studies: number;
  valid_pinned: number;
  groups: { runs: ReceiptGroup; studies: ReceiptGroup };
};
if (receipts.valid_pinned !== receipts.receipts)
  throw new Error("eval/receipts-check.json has receipts that do not verify");
const n = (x: number) => x.toLocaleString("en-US");

// Who answered each step in the recorded evaluation runs (the "recorded" group of npm run receipt:stats; the
// current-system runs and the Nemotron-alone study arm are counted apart there).
interface StatsRow {
  step: string;
  model: string;
  calls: number;
}
const recordedStats = (
  read("eval/receipt-stats.json") as { groups: Array<{ id: string; runs: number; rows: StatsRow[] }> }
).groups.find((g) => g.id === "recorded");
if (!recordedStats) throw new Error("eval/receipt-stats.json has no recorded group: run npm run receipt:stats");
const SHORT: Array<[RegExp, string]> = [
  [/Ultra/, "Ultra"],
  [/Ollama/, "Ollama backup"],
  [/Lightning/, "Lightning"],
];
const shortModel = (m: string) => SHORT.find(([re]) => re.test(m))?.[1] ?? m;
/** "Ultra 504, Lightning 16, Ollama backup 15 (no receipt) of 535", from the recorded group's rows of one step. */
function whoAnswered(step: string, noReceiptNote: boolean): string {
  const rows = recordedStats?.rows.filter((r) => r.step === step) ?? [];
  const order = ["Ultra", "Lightning", "Ollama backup"];
  const parts = rows
    .map((r) => ({ name: shortModel(r.model), calls: r.calls }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
    .map((p) => `${p.name} ${n(p.calls)}${p.name === "Ollama backup" && noReceiptNote ? " (no receipt)" : ""}`);
  return `${parts.join(", ")} of ${n(rows.reduce((t, r) => t + r.calls, 0))}`;
}
const backup = ["Decision", "Critic", "Challenger"].map((step) => ({
  step: step.toLowerCase(),
  calls: recordedStats.rows.filter((r) => r.step === step && /Ollama/.test(r.model)).reduce((t, r) => t + r.calls, 0),
}));
const backupLine = `${backup.reduce((t, b) => t + b.calls, 0)} answers in the recorded evaluation runs (${backup
  .filter((b) => b.calls > 0)
  .map((b) => `${b.calls} ${b.step}`)
  .join(", ")})`;

// The Zetaris roles, from the code: the three runtime roles and one read role per review step (USL_STEP_ROLES).
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (x: number) => WORDS[x] ?? String(x);
const shortRole = (name: string) => name.replace(/^role_/, "").replace(/_agent$/, "");
if (USL_ROLES.length + USL_STEP_ROLES.length !== ZETARIS_ROLES.length)
  throw new Error("the Zetaris roles in usl-spec.ts and client.ts disagree");
const zetarisRoles = `${word(ZETARIS_ROLES.length)[0]?.toUpperCase()}${word(ZETARIS_ROLES.length).slice(1)} Zetaris roles, each with its own non-admin user and token: ${word(USL_STEP_ROLES.length)} per-step read roles (${USL_STEP_ROLES.map((r) => shortRole(r.role)).join(", ")}) plus ${USL_ROLES.map(
  (r) => shortRole(r.name),
)
  .join(", ")
  .replace(/, ([^,]*)$/, " and $1")}`;

const drafts = exam.cases.filter((c) => c.group === "tipping_off").length;
const facts: Record<string, string> = {
  exam_cases: String(exam.cases.length),
  exam_alerts: String(exam.cases.length - drafts),
  exam_drafts: String(drafts),
  exam_groups: String(new Set(exam.cases.map((c) => c.group)).size),
  heldout_cases: String(heldout.cases.length),
  heldout_clears: String(heldout.cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE").length),
  heldout_risks: String(heldout.cases.filter((c) => c.expected !== "CLOSE_FALSE_POSITIVE").length),
  edge_cases: String(edge.edge_cases.length),
  receipts: n(receipts.receipts),
  receipts_runs: n(receipts.from_runs),
  receipts_studies: n(receipts.from_studies),
  runs_exported: String(receipts.groups.runs.folders),
  receipts_runs_memory: n(receipts.groups.runs.with_added_memory),
  receipts_studies_memory: n(receipts.groups.studies.with_added_memory),
  cross_check_runs: (() => {
    const c = receipts.groups.runs.cross_check;
    const kinds = Object.keys(receipts.groups.runs.cross_check_warnings);
    const which = kinds.length === 1 ? `all \`${kinds[0]}\`` : kinds.map((k) => `\`${k}\``).join(", ");
    return `${n(c.skipped ?? 0)} skipped, ${n(c.warning ?? 0)} warning (${which}, risk medium, not blocking), ${n(c.passed ?? 0)} passed`;
  })(),
  receipts_line: receiptsLine(receipts),
  // The one receipt figure (tools/lib/receipt-figure.ts): runs, answers, Nightshift answers verified, Ollama backup answers.
  receipt_figure: receiptSentence(receiptFigure(resolveProjectPath("."))),
  recorded_runs: String(recordedStats.runs),
  who_guard: whoAnswered("Safety guard", false),
  who_screener: whoAnswered("Screener", false),
  who_decision: whoAnswered("Decision", true),
  who_critic: whoAnswered("Critic", false),
  who_challenger: whoAnswered("Challenger", false),
  backup_recorded: backupLine,
  zetaris_roles: zetarisRoles,
  receipt_gate:
    "By design, the desk never uses a Nightshift answer without a valid signature from the pinned key: it retries, then holds the case. Local backup answers carry no receipt and are labelled 'Ollama backup, no receipt'.",
  harness_agent_files: `${harness.agent_files.naming_any_source} of ${harness.agent_files.scanned} agent files name any source, table or driver`,
  // Who answered the decision, critic and challenger calls, from the receipts of the exported runs (nemotron:scorecard).
  ...(read("eval/nemotron-scorecard.json") as { reasoning_facts: Record<string, string> }).reasoning_facts,
  ...(saved.tests ? { tests: saved.tests.toLocaleString("en-US") } : {}),
};

const pkg = read("package.json") as {
  license: string;
  engines: { node: string };
  devDependencies: Record<string, string>;
  repository: { url: string };
};
const repo = pkg.repository.url.replace(/\.git$/, "");
/** One static shields.io badge; dashes and underscores are doubled, other characters are URL-encoded. */
const shield = (label: string, message: string, color: string, extra = "") =>
  `https://img.shields.io/badge/${[label, message].map((t) => encodeURIComponent(t.replaceAll("-", "--").replaceAll("_", "__"))).join("-")}-${color}${extra}`;
const tsMajor = (pkg.devDependencies.typescript ?? "").replace(/^[^0-9]*/, "").split(".")[0] ?? "";
const badges = [
  "<!-- badges:start -->",
  [
    `[![CI](${repo}/actions/workflows/ci.yml/badge.svg?branch=main)](${repo}/actions/workflows/ci.yml)`,
    `[![TypeScript ${tsMajor}](${shield("TypeScript", tsMajor, "3178C6", "?logo=typescript&logoColor=white")})](package.json)`,
    `[![Node ${pkg.engines.node}](${shield("node", pkg.engines.node, "339933", "?logo=nodedotjs&logoColor=white")})](package.json)`,
    `[![License ${pkg.license}](${shield("license", pkg.license, "blue")})](LICENSE)`,
  ].join(" "),
  "<!-- badges:end -->",
].join("\n");

const files = [
  "README.md",
  ...readdirSync(resolveProjectPath("docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];
// Documents kept on this machine only (not in the repository): refreshed when present, never checked in CI.
const LOCAL_ONLY = ["SUBMISSION-DESCRIPTION.md", "DECK-OUTLINE.md"].map((f) => join("internal", f));
if (!process.argv.includes("--check")) files.push(...LOCAL_ONLY.filter((f) => existsSync(resolveProjectPath(f))));
const pattern = /<!--fact:(\w+)-->(.*?)<!--\/fact-->/g;
let stale = 0;
for (const file of files) {
  const path = resolveProjectPath(file);
  const text = readFileSync(path, "utf8");
  let next = text.replace(pattern, (_whole, name: string, value: string) => {
    const wanted = facts[name];
    if (wanted === undefined) throw new Error(`${file}: unknown fact "${name}"`);
    if (wanted !== value) stale += 1;
    return `<!--fact:${name}-->${wanted}<!--/fact-->`;
  });
  const block = /<!-- badges:start -->[\s\S]*?<!-- badges:end -->/;
  if (block.test(next)) {
    const current = next.match(block)?.[0];
    if (current !== badges) stale += 1;
    next = next.replace(block, badges);
  }
  if (next !== text && !process.argv.includes("--check")) writeFileSync(path, next);
}
if (process.argv.includes("--check") && stale > 0) {
  console.error(`${stale} marked value(s) are out of date; run npm run readme:refresh`);
  process.exit(1);
}
console.log(
  `facts: ${Object.entries(facts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")}${stale ? `; refreshed ${stale}` : ""}`,
);

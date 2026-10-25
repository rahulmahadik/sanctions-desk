/**
 * Summarise the committed adversarial run of the safety guard (eval/adversarial/guard-*.json, written by
 * npm run adversarial:guard) into the adversarial blocks of docs/EVALUATION.md, docs/NEMOTRON.md and README.md, and
 * the run of the same texts through full reviews (eval/adversarial/review-*.json, npm run adversarial:review) into the
 * adversarial-review block of docs/EVALUATION.md and one sentence of the short blocks.
 * Every number comes from the result file; nothing is typed in by hand.
 *
 *   npm run adversarial:summary
 *   npm run adversarial:summary -- --check   # fails if a block is out of date
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";

interface Row {
  case_id: string;
  family: "injection" | "tipping_off" | "benign" | "clean_draft";
  place: string;
  technique: string;
  violation: boolean;
  flagged: boolean;
  by_patterns: boolean;
  by_model: boolean;
  receipts?: string[];
}
interface Run {
  at: string;
  policy_version: number;
  summary: { cases: number; errors: number };
  rows: Row[];
}

const check = process.argv.includes("--check");
const dir = resolveProjectPath("eval/adversarial");
const file = readdirSync(dir)
  .filter((f) => /^guard-.*\.json$/.test(f))
  .sort()
  .at(-1);
if (!file) throw new Error("no adversarial run in eval/adversarial: run npm run adversarial:guard first");
const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as Run;
const rel = `eval/adversarial/${file}`;

const fam = (f: Row["family"]) => run.rows.filter((r) => r.family === f);
const count = (rows: Row[], p: (r: Row) => boolean) => rows.filter(p).length;
const injection = fam("injection");
const tipping = fam("tipping_off");
const harmless = [...fam("benign"), ...fam("clean_draft")];
const mustFlag = [...injection, ...tipping];
const techniques = new Set(injection.map((r) => r.technique)).size;
const places = new Set(injection.map((r) => r.place.replaceAll("_", " "))).size;
const falseFlags = harmless.filter((r) => r.flagged).map((r) => `${r.case_id}, a ${r.place.replaceAll("_", " ")}`);
const withReceipt = count(run.rows, (r) => (r.receipts?.length ?? 0) > 0);
const day = run.at.slice(0, 10);

const row = (label: string, rows: Row[], must: boolean) =>
  `| ${label} | ${rows.length} | ${must ? "flag" : "pass"} | ${count(rows, (r) => r.by_patterns)} | ${count(rows, (r) => r.by_model)} | ${count(rows, (r) => r.flagged)} |`;

const limits = `Limits: it tests the safety guard only (not the decision, critic or challenger, and not a full review), under policy version ${run.policy_version}, in one run on ${day}; the texts were written for this test, and a different wording can behave differently.`;

const evaluation = [
  `**Safety guard against injected instructions and tipping-off drafts, one run (${rel}).** ${run.summary.cases} texts: ${injection.length} instructions aimed at the reviewer hidden in ${places} places (customer notes, payment references, listed-party remarks) with ${techniques} techniques (plain, polite, role play, markup, hidden spacing and zero-width characters, look-alike letters, other languages, JSON smuggling and more), ${tipping.length} reworded customer drafts that tip the customer off, and ${harmless.length} harmless texts. Each text went to the guard as shipped: the fixed patterns, then Nemotron 3.5 Lightning on the laptop through Nightshift.`,
  "",
  "| Texts | Cases | Expected | Caught by the fixed patterns | Flagged by Lightning alone | Flagged by the guard as shipped |",
  "| --- | ---: | --- | ---: | ---: | ---: |",
  row("Injected instructions", injection, true),
  row("Tipping-off drafts", tipping, true),
  row("Harmless texts (notes, references, remarks, clean drafts)", harmless, false),
  "",
  `Of the ${mustFlag.length} texts that must be flagged, the guard flagged ${count(mustFlag, (r) => r.flagged)}; ${count(mustFlag, (r) => r.by_model && !r.by_patterns)} of them only Lightning caught. Harmless texts wrongly flagged: ${falseFlags.length} of ${harmless.length}${falseFlags.length ? ` (${falseFlags.join(", ")})` : ""}. Errors: ${run.summary.errors}. Every model call has a receipt id (${withReceipt} of ${run.rows.length}).`,
  "",
  limits,
].join("\n");

// The same texts through full live reviews, when that run is committed.
interface ReviewRow {
  case_id: string;
  family: Row["family"] | "baseline";
  place: string;
  violation: boolean;
  alert_id?: string;
  decision: string;
  receipts: number;
}
const reviewFile = readdirSync(dir)
  .filter((f) => /^review-.*\.json$/.test(f))
  .sort()
  .at(-1);
const review = reviewFile
  ? (JSON.parse(readFileSync(join(dir, reviewFile), "utf8")) as {
      at: string;
      policy_version: number;
      rows: ReviewRow[];
    })
  : undefined;
let reviewBlock: string | undefined;
let reviewShort = "";
if (review && reviewFile) {
  const rr = (f: ReviewRow["family"]) => review.rows.filter((r) => r.family === f);
  const closed = (r: ReviewRow) => r.decision === "CLOSE_FALSE_POSITIVE";
  const errors = (rows: ReviewRow[]) => rows.filter((r) => r.decision === "ERROR").length;
  const bases = rr("baseline");
  const inj = rr("injection");
  const ben = rr("benign");
  const tip = rr("tipping_off");
  const clean = rr("clean_draft");
  const reviewDay = review.at.slice(0, 10);
  const injClosed = inj.filter(closed).map((r) => r.case_id);
  const line = (label: string, rows: ReviewRow[], expected: string, shown: string) =>
    `| ${label} | ${rows.length} | ${expected} | ${shown} | ${errors(rows)} |`;
  reviewBlock = [
    `**The same texts through full live reviews, one run (eval/adversarial/${reviewFile}, ${reviewDay}, policy version ${review.policy_version}).** Each customer note, payment reference or listed-party remark was put in an alert whose structured data closes (${bases.map((b) => `${b.alert_id}: ${b.decision === "CLOSE_FALSE_POSITIVE" ? "closes" : b.decision}`).join(", ")} with all free-text fields blank), replacing the text in the rows Zetaris returned, in memory; nothing was written to Zetaris or any source. The review then ran as shipped: the safety guard, the screener, the decision on Nemotron 3 Ultra, the critic, the challenger and the policy guard. The drafts went to the outbound guard, which is where a draft is checked.`,
    "",
    "| Texts | Cases | Expected | Result | Errors |",
    "| --- | ---: | --- | --- | ---: |",
    line(
      "Injected instructions",
      inj,
      "not closed",
      `${inj.length - injClosed.length - errors(inj)} not closed, ${injClosed.length} closed`,
    ),
    line(
      "Harmless texts in the data",
      ben,
      "closed (the base closes)",
      `${ben.filter(closed).length} closed, ${ben.length - ben.filter(closed).length - errors(ben)} held for a person`,
    ),
    line("Tipping-off drafts", tip, "blocked", `${tip.filter((r) => r.decision === "DRAFT_BLOCKED").length} blocked`),
    line("Clean drafts", clean, "allowed", `${clean.filter((r) => r.decision === "DRAFT_ALLOWED").length} allowed`),
    "",
    `Injected instructions that ended in a close: ${injClosed.length === 0 ? "none" : injClosed.join(", ")}. Receipts: ${review.rows.reduce((t, r) => t + r.receipts, 0)} model calls with a receipt id. A harmless text that is held costs a person's time, not a wrong close.`,
  ].join("\n");
  reviewShort = ` Through full reviews (${reviewDay}): ${injClosed.length} of ${inj.length} injected instructions ended in a close; ${ben.filter(closed).length} of ${ben.length} harmless texts were closed as the base alert is.`;
}

const short = `**Safety guard against injected text (one run, ${day}, policy ${run.policy_version}):** Lightning flagged ${count(injection, (r) => r.by_model)} of ${injection.length} injected instructions, against ${count(injection, (r) => r.by_patterns)} for the fixed patterns alone, and ${count(tipping, (r) => r.by_model)} of ${tipping.length} tipping-off drafts (patterns: ${count(tipping, (r) => r.by_patterns)}); it wrongly flagged ${falseFlags.length} of ${harmless.length} harmless texts. It tests the safety guard only, not a full review.${reviewShort} Details: `;

let changed = false;
if (reviewBlock) {
  const target = resolveProjectPath("docs/EVALUATION.md");
  const doc = readFileSync(target, "utf8");
  const re = /<!-- adversarial-review:start -->[\s\S]*?<!-- adversarial-review:end -->/;
  if (re.test(doc)) {
    const next = formatMarkdown(
      doc.replace(re, () => `<!-- adversarial-review:start -->\n${reviewBlock}\n<!-- adversarial-review:end -->`),
      target,
    );
    if (next !== doc) {
      changed = true;
      if (!check) writeFileSync(target, next);
    }
  }
}
for (const [path, body, formatted] of [
  ["docs/EVALUATION.md", evaluation, true],
  ["docs/NEMOTRON.md", `${short}[EVALUATION.md](EVALUATION.md#safety-guard-against-injected-text).`, true],
  ["README.md", `- ${short}[docs/EVALUATION.md](docs/EVALUATION.md#safety-guard-against-injected-text).`, false],
] as const) {
  const target = resolveProjectPath(path);
  if (!existsSync(target)) continue;
  const doc = readFileSync(target, "utf8");
  const re = /(<!-- adversarial:start -->)[\s\S]*?(<!-- adversarial:end -->)/;
  if (!re.test(doc)) throw new Error(`${path} has no adversarial block`);
  const replaced = doc.replace(re, () => `<!-- adversarial:start -->\n${body}\n<!-- adversarial:end -->`);
  const next = formatted ? formatMarkdown(replaced, target) : replaced;
  if (next !== doc) {
    changed = true;
    if (!check) writeFileSync(target, next);
  }
}
if (check && changed) {
  console.error("the adversarial summary is out of date: run npm run adversarial:summary");
  process.exit(1);
}
console.log(`${check ? "checked" : "wrote"} the adversarial summary from ${rel}`);

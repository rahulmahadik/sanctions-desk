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

// The same texts through full live reviews, when that run is committed and scored (npm run adversarial:review --
// --score): a text is caught only when the safety guard or the screener flagged the text itself; the case outcome is
// reported beside it, with each base alert's own outcome.
interface ReviewRow {
  case_id: string;
  family: Row["family"] | "baseline";
  place: string;
  violation: boolean;
  alert_id?: string;
  decision: string;
  receipts: number;
  caught?: boolean;
  guard?: { flagged: boolean; pattern_hits: number; model_answered: boolean | null; reason: string } | null;
  screener?: { flagged: boolean; signals: string[] } | null;
}
interface ReviewRun {
  at: string;
  policy_version: number;
  rows: ReviewRow[];
  base_repeats?: Record<string, { at: string; repeats: Array<{ decision: string }> }>;
}
const reviewFile = readdirSync(dir)
  .filter((f) => /^review-.*\.json$/.test(f))
  .sort()
  .at(-1);
const review = reviewFile ? (JSON.parse(readFileSync(join(dir, reviewFile), "utf8")) as ReviewRun) : undefined;
let reviewBlock: string | undefined;
let reviewShort = "";
if (review && reviewFile) {
  if (review.rows.some((r) => r.family !== "baseline" && r.caught === undefined))
    throw new Error(
      `${reviewFile} is not scored: run npm run adversarial:review -- --score eval/adversarial/${reviewFile}`,
    );
  const rr = (f: ReviewRow["family"]) => review.rows.filter((r) => r.family === f);
  const n = (rows: ReviewRow[], p: (r: ReviewRow) => boolean) => rows.filter(p).length;
  const closed = (r: ReviewRow) => r.decision === "CLOSE_FALSE_POSITIVE";
  const err = (r: ReviewRow) => r.decision === "ERROR";
  const reviewDay = review.at.slice(0, 10);
  const bases = rr("baseline");
  const baseOf = (alert?: string) => bases.find((b) => b.alert_id === alert)?.decision ?? "not run";
  const inbound = (f: ReviewRow["family"]) => rr(f).filter((r) => r.place !== "draft");
  const inj = inbound("injection");
  const ben = inbound("benign");
  const tip = rr("tipping_off");
  const clean = rr("clean_draft");
  const outcome = (rows: ReviewRow[]) =>
    `${n(rows, closed)} closed, ${n(rows, (r) => !closed(r) && !err(r))} held for a person${n(rows, err) ? `, ${n(rows, err)} errors` : ""}`;
  const byBase = (rows: ReviewRow[]) =>
    [...new Set(rows.map((r) => r.alert_id))]
      .map((a) => {
        const sub = rows.filter((r) => r.alert_id === a);
        return `in ${a} (its own outcome: ${baseOf(a)}): ${outcome(sub)}`;
      })
      .join("; ");
  const line = (label: string, rows: ReviewRow[], expected: string) =>
    `| ${label} | ${rows.length} | ${expected} | ${n(rows, (r) => r.caught === true)} | ${n(rows, (r) => r.guard?.flagged === true)} | ${n(rows, (r) => r.screener?.flagged === true)} | ${byBase(rows)} |`;
  const repeats = Object.entries(review.base_repeats ?? {}).map(
    ([alert, r]) =>
      `${alert} reviewed alone ${r.repeats.length} more times with its free text blank: it closed ${r.repeats.filter((x) => x.decision === "CLOSE_FALSE_POSITIVE").length} of ${r.repeats.length} (${r.repeats.map((x) => x.decision).join(", ")})`,
  );
  const missedInj = inj.filter((r) => !r.caught).map((r) => r.case_id);
  const injClosed = inj.filter(closed).map((r) => r.case_id);
  const falseFlags = ben.filter((r) => r.caught).map((r) => r.case_id);
  reviewBlock = [
    `**The same texts through full live reviews, one run (eval/adversarial/${reviewFile}, ${reviewDay}, policy version ${review.policy_version}).** Each customer note, payment reference or listed-party remark was put in a base alert whose structured data closes, with its other free-text fields blank, by replacing the text in the rows Zetaris returned, in memory; nothing was written to Zetaris or any source. The review then ran as shipped (safety guard, screener, decision on Nemotron 3 Ultra, critic, challenger, policy guard). A text counts as **caught** only when the safety guard or the screener flagged the text itself (their verdicts and reasons are in the result file); the case outcome is shown beside it and does not count as a catch, because a case can be held for other reasons. The drafts went to the outbound guard, which is where a draft is checked.`,
    "",
    "| Texts | Cases | Expected | Caught (guard or screener flagged the text) | Flagged by the safety guard | Flagged by the screener | Case outcome, per base alert |",
    "| --- | ---: | --- | ---: | ---: | ---: | --- |",
    line("Injected instructions", inj, "caught"),
    line("Harmless texts in the data", ben, "not caught"),
    `| Tipping-off drafts | ${tip.length} | blocked | ${n(tip, (r) => r.caught === true)} | ${n(tip, (r) => r.caught === true)} | n/a | blocked: ${n(tip, (r) => r.decision === "DRAFT_BLOCKED")} |`,
    `| Clean drafts | ${clean.length} | allowed | ${n(clean, (r) => r.caught === true)} | ${n(clean, (r) => r.caught === true)} | n/a | allowed: ${n(clean, (r) => r.decision === "DRAFT_ALLOWED")} |`,
    "",
    `Base alerts with all free text blank, in this run: ${bases.map((b) => `${b.alert_id} ${b.decision}`).join(", ")}.${repeats.length ? ` ${repeats.join("; ")}.` : ""} Injected instructions not caught: ${missedInj.length ? missedInj.join(", ") : "none"}. Injected instructions whose case was closed: ${injClosed.length ? injClosed.join(", ") : "none"}. Harmless texts flagged: ${falseFlags.length ? falseFlags.join(", ") : "none"}. ${review.rows.reduce((s, r) => s + r.receipts, 0)} model calls with a receipt id.`,
  ].join("\n");
  reviewShort = ` Through full reviews (${reviewDay}): the guard or screener caught ${n(inj, (r) => r.caught === true)} of ${inj.length} injected instructions in the data, and ${injClosed.length} of those cases were closed.`;
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

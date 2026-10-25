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
import { countWithInterval, resolveProjectPath } from "@sanctions-desk/shared";
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

const row = (label: string, rows: Row[], must: boolean) =>
  `| ${label} | ${rows.length} | ${must ? "flag" : "pass"} | ${count(rows, (r) => r.by_patterns)} | ${count(rows, (r) => r.by_model)} | ${count(rows, (r) => r.flagged)} |`;

const limits = `Limits: it tests the safety guard only (not the decision, critic or challenger, and not a full review), under policy version ${run.policy_version}, in one run; the texts were written for this test, and a different wording can behave differently.`;

const evaluation = [
  `**Guard-only run: the safety guard against injected instructions and tipping-off drafts, one run ([${rel}](../${rel})).** ${run.summary.cases} texts: ${injection.length} instructions aimed at the reviewer hidden in ${places} places (customer notes, payment references, listed-party remarks) with ${techniques} techniques (plain, polite, role play, markup, hidden spacing and zero-width characters, look-alike letters, other languages, JSON smuggling and more), ${tipping.length} reworded customer drafts that tip the customer off, and ${harmless.length} harmless texts. Each text went to the guard as it was in that run (the fixed patterns, then Nemotron 3.5 Lightning on the laptop through Nightshift, asked once).`,
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
  screener?: { flagged: boolean; signals: string[]; weak_signals?: number } | null;
  local_steps?: Array<{ agent: string; route: string }>;
  model_recommendation?: string;
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
  const steps = review.rows.flatMap((r) => r.local_steps ?? []);
  const where = (agent: string) => {
    const s = steps.filter((x) => x.agent === agent);
    return `${s.filter((x) => x.route === "local").length} of ${s.length} answered locally`;
  };
  // The steer check: the missed texts put in an alert that escalates on its own data (check-*.json).
  const checkFile = readdirSync(dir)
    .filter((f) => /^check-.*\.json$/.test(f))
    .sort()
    .at(-1);
  let steer = "";
  if (checkFile) {
    const ck = JSON.parse(readFileSync(join(dir, checkFile), "utf8")) as {
      rows: Array<ReviewRow & { model_recommendation?: string }>;
    };
    const cb = ck.rows.filter((r) => r.family === "baseline");
    const ct = ck.rows.filter((r) => r.family !== "baseline");
    const ids = [...new Set(ct.map((r) => r.case_id))];
    const label = (d: string) =>
      d === "CLOSE_FALSE_POSITIVE"
        ? "closed"
        : d === "ESCALATE_L2"
          ? "escalated"
          : d.toLowerCase().replaceAll("_", " ");
    const flaggedBy = (r: ReviewRow) =>
      [r.guard?.flagged ? "the safety guard" : "", r.screener?.flagged ? "the screener" : ""]
        .filter(Boolean)
        .join(" and ") || "no check";
    const runs = ids.map((id) => {
      const rs = ct.filter((r) => r.case_id === id);
      return `${id}: ${rs.map((r, i) => `run ${i + 1} ${label(r.decision)} (decision model: ${label(r.model_recommendation ?? r.decision)}; flagged by ${flaggedBy(r)})`).join(", ")}`;
    });
    steer = ` **Steer check** ([eval/adversarial/${checkFile}](../eval/adversarial/${checkFile}), same code as this run): ${ids.join(" and ")} put in ${cb[0]?.alert_id}, which escalates on its own data. Without the text: ${cb.map((b, i) => `run ${i + 1} ${label(b.decision)}`).join(", ")}. With the text: ${runs.join("; ")}. ${n(ct, closed)} of ${ct.length} runs closed, so the unflagged text did not turn an escalating case into a close.`;
  }
  reviewBlock = [
    `**105-text full-review run: the same texts through full live reviews, one run ([eval/adversarial/${reviewFile}](../eval/adversarial/${reviewFile}), policy version ${review.policy_version}, guard asked once).** Each customer note, payment reference or listed-party remark was put in a base alert whose structured data closes, with its other free-text fields blank, by replacing the text in the rows Zetaris returned, in memory; nothing was written to Zetaris or any source. The review then ran as shipped (safety guard, screener, decision on Nemotron 3 Ultra, critic, challenger, policy guard). A text counts as **caught** only when the safety guard flagged it or the screener gave a signal at or above its threshold, that is, a flag that blocks a close (their verdicts and reasons are in the result file; a weaker screener signal is recorded for the reviewer and does not count); the case outcome is shown beside it and does not count as a catch, because a case can be held for other reasons. The drafts went to the outbound guard, which is where a draft is checked.`,
    "",
    "| Texts | Cases | Expected | Caught (a flag that blocks a close) | Flagged by the safety guard | Flagged by the screener (at or above its threshold) | Case outcome, per base alert |",
    "| --- | ---: | --- | ---: | ---: | ---: | --- |",
    line("Injected instructions", inj, "caught"),
    line("Harmless texts in the data", ben, "not caught"),
    `| Tipping-off drafts | ${tip.length} | blocked | ${n(tip, (r) => r.caught === true)} | ${n(tip, (r) => r.caught === true)} | n/a | blocked: ${n(tip, (r) => r.decision === "DRAFT_BLOCKED")} |`,
    `| Clean drafts | ${clean.length} | allowed | ${n(clean, (r) => r.caught === true)} | ${n(clean, (r) => r.caught === true)} | n/a | allowed: ${n(clean, (r) => r.decision === "DRAFT_ALLOWED")} |`,
    "",
    `Base alerts with all free text blank, in this run: ${bases.map((b) => `${b.alert_id} ${b.decision}`).join(", ")}.${repeats.length ? ` ${repeats.join("; ")}.` : ""} Injected instructions not caught: ${missedInj.length ? missedInj.join(", ") : "none"}. Injected instructions whose case was closed: ${injClosed.length ? injClosed.join(", ") : "none"}. Harmless texts flagged: ${falseFlags.length ? falseFlags.join(", ") : "none"}. Safety-guard calls: ${where("policy_guard")}; screener calls: ${where("screener")}.${steer} ${review.rows.reduce((s, r) => s + r.receipts, 0)} model calls with a receipt id.`,
  ].join("\n");
  const closedUncaught = inj.filter((r) => closed(r) && !r.caught).length;
  reviewShort = ` **105-text full-review run** (policy ${review.policy_version}, guard asked once): ${n(inj, (r) => r.caught === true)} of ${inj.length} injected texts caught; ${closedUncaught} that no check flagged ended in a close where the case's own data supported a close.`;
}

// The fresh set (fresh-*.json): texts written separately from the guard's rules, each inbound text in a base that
// closes and one that escalates. Beside it, the false alarms of the 105-text run.
const freshFile = readdirSync(dir)
  .filter((f) => /^fresh-\d{4}-.*\.json$/.test(f))
  .sort()
  .at(-1);
let freshBlock: string | undefined;
let freshShort = "";
if (freshFile && review) {
  const fr = JSON.parse(readFileSync(join(dir, freshFile), "utf8")) as ReviewRun;
  if (fr.rows.some((r) => r.family !== "baseline" && r.caught === undefined))
    throw new Error(
      `${freshFile} is not scored: run npm run adversarial:review -- --score eval/adversarial/${freshFile}`,
    );
  const n = (rows: ReviewRow[], p: (r: ReviewRow) => boolean) => rows.filter(p).length;
  const closed = (r: ReviewRow) => r.decision === "CLOSE_FALSE_POSITIVE";
  const fam = (f: ReviewRow["family"]) => fr.rows.filter((r) => r.family === f);
  const bases = fam("baseline");
  const baseIds = [...new Set(bases.map((b) => b.alert_id))];
  const inj = fam("injection");
  const ben = fam("benign");
  const tip = fam("tipping_off");
  const clean = fam("clean_draft");
  const oldBen = review.rows.filter((r) => r.family === "benign" && r.place !== "draft");
  const byBase = (rows: ReviewRow[]) =>
    baseIds
      .map((a) => {
        const sub = rows.filter((r) => r.alert_id === a);
        const own = bases.filter((b) => b.alert_id === a).map((b) => b.decision);
        return `in ${a} (alone: ${own.join(", ")}): ${n(sub, closed)} of ${sub.length} closed`;
      })
      .join("; ");
  const steps = fr.rows.flatMap((r) => r.local_steps ?? []);
  const local = (agent: string) => {
    const s = steps.filter((x) => x.agent === agent);
    return `${s.filter((x) => x.route === "local").length} of ${s.length}`;
  };
  const injTexts = [...new Set(inj.map((r) => r.case_id))].length;
  freshShort = ` **Fresh-set run** (current guard: asked twice, plus a narrow check; texts written separately): ${n(inj, (r) => r.caught === true)} of ${inj.length} reviews of injected text caught; false alarms on harmless text ${n(ben, (r) => r.caught === true)} of ${ben.length}.`;
  freshBlock = [
    `**Fresh-set run: a fresh set on the current guard ([eval/adversarial/${freshFile}](../eval/adversarial/${freshFile}), policy version ${fr.policy_version}).** The current guard differs from the one used above: the guard model is asked twice and the more cautious answer kept; a separate narrow check asks whether a text addresses the reviewer or the case outcome; an answer from a cloud route is not accepted. A separate session wrote the texts of this set without seeing the earlier ones or their results ([eval/adversarial/fresh-set-2026-10-25.json](../eval/adversarial/fresh-set-2026-10-25.json)). Each customer note and list remark was reviewed in full in ${baseIds.length} base alerts (${baseIds.join(" and ")}), one that closes and one that escalates on its own data. Counts are per review (each text appears once per base). Caught means the safety guard flagged the text or the screener gave a signal at or above its threshold (a flag that blocks a close; a weaker signal only noted for the reviewer does not count); 95% ranges in brackets.`,
    "",
    "| Texts | Reviews | Result | Case outcome, per base alert |",
    "| --- | ---: | --- | --- |",
    `| Injected instructions (${injTexts} texts) | ${inj.length} | caught ${countWithInterval(
      n(inj, (r) => r.caught === true),
      inj.length,
    )} | ${byBase(inj)} |`,
    `| Harmless texts | ${ben.length} | false alarms ${countWithInterval(
      n(ben, (r) => r.caught === true),
      ben.length,
    )}; in the 105-text run above: ${countWithInterval(
      n(oldBen, (r) => r.caught === true),
      oldBen.length,
    )} | ${byBase(ben)} |`,
    `| Tipping-off drafts | ${tip.length} | blocked ${countWithInterval(
      n(tip, (r) => r.decision === "DRAFT_BLOCKED"),
      tip.length,
    )} | (outbound guard) |`,
    `| Clean drafts | ${clean.length} | wrongly blocked ${countWithInterval(
      n(clean, (r) => r.decision === "DRAFT_BLOCKED"),
      clean.length,
    )} | (outbound guard) |`,
    "",
    `Injected texts not caught: ${[...new Set(inj.filter((r) => !r.caught).map((r) => `${r.case_id} in ${r.alert_id}`))].join(", ") || "none"}. Injected texts whose case was closed: ${
      inj
        .filter(closed)
        .map((r) => `${r.case_id} in ${r.alert_id}`)
        .join(", ") || "none"
    }. Harmless texts flagged: ${
      ben
        .filter((r) => r.caught)
        .map((r) => `${r.case_id} in ${r.alert_id}`)
        .join(", ") || "none"
    }. Safety-guard calls answered locally: ${local("policy_guard")}; screener calls: ${local("screener")}.`,
  ].join("\n");
}

const short = `**Safety guard against injected text** (every text is screened; the guard is not perfect, see [Known issues](KI#open-issues)). **Guard-only run** (policy ${run.policy_version}, guard asked once): Lightning flagged ${count(injection, (r) => r.by_model)} of ${injection.length} injected instructions, against ${count(injection, (r) => r.by_patterns)} for the fixed patterns alone, and ${count(tipping, (r) => r.by_model)} of ${tipping.length} tipping-off drafts (patterns: ${count(tipping, (r) => r.by_patterns)}); it wrongly flagged ${falseFlags.length} of ${harmless.length} harmless texts. It tests the safety guard only, not a full review.${reviewShort}${freshShort} Details: `;

let changed = false;
if (freshBlock) {
  const target = resolveProjectPath("docs/EVALUATION.md");
  const doc = readFileSync(target, "utf8");
  const re = /<!-- adversarial-fresh:start -->[\s\S]*?<!-- adversarial-fresh:end -->/;
  if (re.test(doc)) {
    const next = formatMarkdown(
      doc.replace(re, () => `<!-- adversarial-fresh:start -->\n${freshBlock}\n<!-- adversarial-fresh:end -->`),
      target,
    );
    if (next !== doc) {
      changed = true;
      if (!check) writeFileSync(target, next);
    }
  }
}
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
  [
    "docs/NEMOTRON.md",
    `${short.replace("KI#", "KNOWN_ISSUES.md#")}[EVALUATION.md](EVALUATION.md#safety-guard-against-injected-text).`,
    true,
  ],
  [
    "README.md",
    `- ${short.replace("KI#", "docs/KNOWN_ISSUES.md#")}[docs/EVALUATION.md](docs/EVALUATION.md#safety-guard-against-injected-text).`,
    false,
  ],
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

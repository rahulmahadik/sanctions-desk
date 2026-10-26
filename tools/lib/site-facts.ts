/**
 * The figures on the site's home page, computed from the same committed files the README facts come from, and written
 * into site/index.html between <!--fact:name-->...<!--/fact--> markers (the README's convention) by npm run site:build:
 *
 * - risk cases wrongly closed by the full system, newest 70-case run, from eval/nemotron-scorecard.json (the arms the
 *   scorecard scores with tools/lib/exam-figures.ts; CI checks the file against the result files);
 * - the same for Nemotron alone with the free text, from the same file;
 * - signed receipts, all verified, from eval/receipts-check.json (npm run receipts:check);
 * - the per-step read roles in Zetaris, from the code (USL_STEP_ROLES, the roles fact of the README);
 * - the story of one alert (STORY_CASE, the case in the demo video): Nemotron alone's confidence in its close, the same
 *   in both Nemotron-alone runs, and how many full-system runs held it for a person, from the result files the
 *   scorecard names. The links to those files fill the <!-- story-links:start --> block.
 *
 * The step-to-model card between <!-- steps:start --> and <!-- steps:end --> is written from STEPS, the table the
 * Nemotron scorecard checks against docs/NEMOTRON.md, so the card cannot name a model the docs do not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USL_STEP_ROLES } from "@sanctions-desk/zetaris";
import { type ExamArmRow, STEPS } from "./nemotron-scorecard.js";
import { esc, REPO_URL } from "./site-chrome.js";

export class SiteFactsError extends Error {}

const read = <T>(root: string, rel: string): T => {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
  } catch (err) {
    throw new SiteFactsError(`${rel} cannot be read: ${(err as Error).message}`);
  }
};
const ofN = (wrong: number, risk: number) => `${wrong} of ${risk}`;

/** The alert the home page follows from start to finish: ALR-0073, exam case EX-064, the case in the demo video. */
export const STORY_CASE = "EX-064";
const OUTCOME_TEXT: Record<string, string> = {
  CLOSE_FALSE_POSITIVE: "close as a false positive",
  ESCALATE_L2: "escalate to level 2",
  NEED_MORE_INFO: "ask for more information",
  RECOMMEND_BLOCK: "recommend a block",
};
type StoryCase = { case_id: string; got: string; confidence?: number };

/** The newest arm with figures whose label starts with `prefix`, in the scorecard's order (oldest system first). */
function newestArm(
  arms: readonly ExamArmRow[],
  prefix: string,
): ExamArmRow & { figures: NonNullable<ExamArmRow["figures"]> } {
  const arm = [...arms].reverse().find((a) => a.arm.startsWith(prefix) && a.figures);
  if (!arm?.figures) throw new SiteFactsError(`eval/nemotron-scorecard.json has no scored arm starting "${prefix}"`);
  return { ...arm, figures: arm.figures };
}

/** The scored arm's result-file entry for STORY_CASE. */
function storyCaseOf(root: string, arm: ExamArmRow): StoryCase {
  if (!arm.source) throw new SiteFactsError(`the scorecard arm "${arm.arm}" names no result file`);
  const c = read<{ cases: StoryCase[] }>(root, arm.source).cases.find((x) => x.case_id === STORY_CASE);
  if (!c) throw new SiteFactsError(`${arm.source} has no case ${STORY_CASE}`);
  return c;
}

/** The arms the story card quotes: both Nemotron-alone runs and every full-system run, newest last. */
function storyArms(arms: readonly ExamArmRow[]) {
  const alone = [
    newestArm(arms, "Nemotron alone, with the free text"),
    newestArm(arms, "Nemotron alone, without the free text"),
  ];
  const full = arms.filter((a) => a.arm.startsWith("Full system") && a.source);
  if (full.length === 0) throw new SiteFactsError("eval/nemotron-scorecard.json has no full-system arm");
  return { alone, full };
}

/** The story card's facts; the build stops if the files no longer tell the story the card's heading tells. */
function storyFacts(root: string, arms: readonly ExamArmRow[]): Record<string, string> {
  const { alone, full } = storyArms(arms);
  const aloneCases = alone.map((a) => storyCaseOf(root, a));
  const conf = aloneCases[0]?.confidence;
  if (aloneCases.some((c) => c.got !== "CLOSE_FALSE_POSITIVE" || c.confidence !== conf) || conf === undefined)
    throw new SiteFactsError(`the Nemotron-alone runs no longer both close ${STORY_CASE} at one confidence`);
  const fullCases = full.map((a) => storyCaseOf(root, a));
  const held = fullCases.filter((c) => c.got !== "CLOSE_FALSE_POSITIVE").length;
  if (held !== fullCases.length) throw new SiteFactsError(`a full-system run closed ${STORY_CASE}`);
  const now = fullCases.at(-1)?.got ?? "";
  if (!OUTCOME_TEXT[now]) throw new SiteFactsError(`the newest full-system run has no outcome for ${STORY_CASE}`);
  return {
    story_alone_conf: conf.toFixed(2),
    story_desk_runs: ofN(held, fullCases.length),
    story_desk_now: OUTCOME_TEXT[now],
  };
}

/** The links to the result files behind the story card, on GitHub. */
export function storyLinksHtml(root: string): string {
  const card = read<{ exam_arms: ExamArmRow[] }>(root, "eval/nemotron-scorecard.json");
  const { alone, full } = storyArms(card.exam_arms);
  const newest = full.at(-1) as ExamArmRow;
  const links: Array<[string, ExamArmRow]> = [
    ["Nemotron alone, with the free text", alone[0] as ExamArmRow],
    ["Nemotron alone, without it", alone[1] as ExamArmRow],
    ["the desk, newest run", newest],
  ];
  return links
    .map(([label, a]) => `          <a href="${REPO_URL}/blob/main/${esc(a.source)}">${esc(label)}</a>`)
    .join("\n");
}

/** The values for the markers in site/index.html. */
export function siteFacts(root: string): Record<string, string> {
  const card = read<{ exam_arms: ExamArmRow[] }>(root, "eval/nemotron-scorecard.json");
  const check = read<{ receipts: number; valid_pinned: number }>(root, "eval/receipts-check.json");
  if (check.valid_pinned !== check.receipts)
    throw new SiteFactsError("eval/receipts-check.json has receipts that do not verify against the pinned key");
  const full = newestArm(card.exam_arms, "Full system");
  const alone = newestArm(card.exam_arms, "Nemotron alone, with the free text");
  if (full.figures.risk !== alone.figures.risk)
    throw new SiteFactsError("the full-system and Nemotron-alone arms score different numbers of risk cases");
  return {
    full_wrong: ofN(full.figures.wrong, full.figures.risk),
    alone_wrong: ofN(alone.figures.wrong, alone.figures.risk),
    receipts: check.receipts.toLocaleString("en-US"),
    step_roles: String(USL_STEP_ROLES.length),
    ...storyFacts(root, card.exam_arms),
  };
}

/** Which badge a step's model gets: Lightning on the laptop, Ultra in the cloud, or the Ollama backup. */
export function badgeOf(model: string): { cls: string; text: string } {
  if (/Ollama/.test(model)) return { cls: "badge-backup", text: "Ollama · backup, no receipt" };
  if (/Ultra/.test(model)) return { cls: "badge-cloud", text: "Nemotron 3 Ultra · cloud" };
  return { cls: "badge-local", text: "Nemotron 3.5 Lightning · local" };
}

/** The rows of the step-to-model card, from STEPS. */
export function stepRowsHtml(): string {
  return STEPS.map((s) => {
    const b = badgeOf(s.model);
    return `            <li><span class="step-name">${esc(s.step)}</span><span class="badge ${b.cls}">${b.text}</span></li>`;
  }).join("\n");
}

/** A public enforcement case as the README states it: its short line under "The problem" and its table row. */
export interface EnforcementCase {
  year: string;
  /** The firm as the table names it (the short line may shorten it). */
  firm: string;
  authority: string;
  /** The table's "Authority and outcome" cell after the authority, for example "$2,485,890 settlement". */
  outcome: string;
  /** The one-phrase gap from the short line. */
  gap: string;
  sourceLabel: string;
  sourceUrl: string;
}

const CASE_LINE = /^- \*\*(.+?)\*\* \((OFAC|NYDFS), (\d{4})\): (.+)$/;
const CASE_ROW = /^\| (\d{4}) \| (.+?) \| (OFAC|NYDFS): (.+?) \| .+? \| \[(.+?)\]\((https?:\/\/[^\s)]+)\) \|$/;

/**
 * The public enforcement cases, read from README.md so the home page cannot drift from it: each short line under
 * "The problem" is matched to its table row by year, authority and firm. The build stops when a line has no row.
 */
export function enforcementCases(root: string): EnforcementCase[] {
  let readme: string;
  try {
    readme = readFileSync(join(root, "README.md"), "utf8");
  } catch (err) {
    throw new SiteFactsError(`README.md cannot be read: ${(err as Error).message}`);
  }
  const lines = readme.split("\n");
  const shorts = lines.map((l) => CASE_LINE.exec(l)).filter((m) => m !== null);
  const rows = lines.map((l) => CASE_ROW.exec(l)).filter((m) => m !== null);
  if (shorts.length === 0 || shorts.length !== rows.length)
    throw new SiteFactsError(
      `README.md lists ${shorts.length} enforcement cases but its table has ${rows.length} rows`,
    );
  return shorts.map((s) => {
    const [firm, authority, year, gap] = [s[1] ?? "", s[2] ?? "", s[3] ?? "", s[4] ?? ""];
    const row = rows.find((r) => r[1] === year && r[3] === authority && (r[2] ?? "").startsWith(firm));
    if (!row) throw new SiteFactsError(`README.md has no table row for the ${year} ${firm} case`);
    return {
      year,
      firm: row[2] ?? "",
      authority,
      outcome: row[4] ?? "",
      gap,
      sourceLabel: row[5] ?? "",
      sourceUrl: row[6] ?? "",
    };
  });
}

/** The cards of the home page's enforcement-cases block; each links to the official release, in a new tab. */
export function casesHtml(cases: readonly EnforcementCase[]): string {
  return cases
    .map(
      (c) => `            <li class="case">
              <p class="case-when"><span class="case-year">${esc(c.year)}</span><span class="case-authority">${esc(c.authority)}</span></p>
              <h4 class="case-firm">${esc(c.firm)}</h4>
              <p class="case-gap">${esc(c.gap)}</p>
              <p class="case-outcome">${esc(c.outcome)}</p>
              <a class="case-source" href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.sourceLabel)}</a>
            </li>`,
    )
    .join("\n");
}

const FACT = /<!--fact:(\w+)-->([\s\S]*?)<!--\/fact-->/g;
const STEPS_BLOCK = /(<!-- steps:start -->)[\s\S]*?(<!-- steps:end -->)/;
const STORY_LINKS_BLOCK = /(<!-- story-links:start -->)[\s\S]*?(<!-- story-links:end -->)/;
const CASES_BLOCK = /(<!-- cases:start -->)[\s\S]*?(<!-- cases:end -->)/;

/**
 * The home page with its markers filled; the markers stay, so the page can be filled again. `storyLinks` fills the
 * <!-- story-links:start --> block and `cases` the <!-- cases:start --> block, each when the page has one.
 */
export function fillIndex(
  template: string,
  facts: Record<string, string>,
  storyLinks?: string,
  cases?: string,
): string {
  if (!STEPS_BLOCK.test(template)) throw new SiteFactsError("site/index.html has no <!-- steps:start --> block");
  let seen = 0;
  const out = template
    .replace(FACT, (_whole, name: string) => {
      const value = facts[name];
      if (value === undefined) throw new SiteFactsError(`site/index.html names an unknown fact "${name}"`);
      seen += 1;
      return `<!--fact:${name}-->${esc(value)}<!--/fact-->`;
    })
    .replace(STEPS_BLOCK, (_whole, open: string, close: string) => `${open}\n${stepRowsHtml()}\n            ${close}`)
    .replace(STORY_LINKS_BLOCK, (whole, open: string, close: string) =>
      storyLinks === undefined ? whole : `${open}\n${storyLinks}\n          ${close}`,
    )
    .replace(CASES_BLOCK, (whole, open: string, close: string) =>
      cases === undefined ? whole : `${open}\n${cases}\n            ${close}`,
    );
  if (seen === 0) throw new SiteFactsError("site/index.html has no <!--fact:...--> markers");
  return out;
}

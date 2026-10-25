/**
 * The figures on the site's home page, computed from the same committed files the README facts come from, and written
 * into site/index.html between <!--fact:name-->...<!--/fact--> markers (the README's convention) by npm run site:build:
 *
 * - risk cases wrongly closed by the full system, newest 70-case run, from eval/nemotron-scorecard.json (the arms the
 *   scorecard scores with tools/lib/exam-figures.ts; CI checks the file against the result files);
 * - the same for Nemotron alone with the free text, from the same file;
 * - signed receipts, all verified, from eval/receipts-check.json (npm run receipts:check);
 * - the per-step read roles in Zetaris, from the code (USL_STEP_ROLES, the roles fact of the README).
 *
 * The step-to-model card between <!-- steps:start --> and <!-- steps:end --> is written from STEPS, the table the
 * Nemotron scorecard checks against docs/NEMOTRON.md, so the card cannot name a model the docs do not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USL_STEP_ROLES } from "@sanctions-desk/zetaris";
import { type ExamArmRow, STEPS } from "./nemotron-scorecard.js";
import { esc } from "./site-chrome.js";

export class SiteFactsError extends Error {}

const read = <T>(root: string, rel: string): T => {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
  } catch (err) {
    throw new SiteFactsError(`${rel} cannot be read: ${(err as Error).message}`);
  }
};
const ofN = (wrong: number, risk: number) => `${wrong} of ${risk}`;

/** The newest arm with figures whose label starts with `prefix`, in the scorecard's order (oldest system first). */
function newestArm(
  arms: readonly ExamArmRow[],
  prefix: string,
): ExamArmRow & { figures: NonNullable<ExamArmRow["figures"]> } {
  const arm = [...arms].reverse().find((a) => a.arm.startsWith(prefix) && a.figures);
  if (!arm?.figures) throw new SiteFactsError(`eval/nemotron-scorecard.json has no scored arm starting "${prefix}"`);
  return { ...arm, figures: arm.figures };
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

const FACT = /<!--fact:(\w+)-->([\s\S]*?)<!--\/fact-->/g;
const STEPS_BLOCK = /(<!-- steps:start -->)[\s\S]*?(<!-- steps:end -->)/;

/** The home page with its markers filled; the markers stay, so the page can be filled again. */
export function fillIndex(template: string, facts: Record<string, string>): string {
  if (!STEPS_BLOCK.test(template)) throw new SiteFactsError("site/index.html has no <!-- steps:start --> block");
  let seen = 0;
  const out = template
    .replace(FACT, (_whole, name: string) => {
      const value = facts[name];
      if (value === undefined) throw new SiteFactsError(`site/index.html names an unknown fact "${name}"`);
      seen += 1;
      return `<!--fact:${name}-->${esc(value)}<!--/fact-->`;
    })
    .replace(STEPS_BLOCK, (_whole, open: string, close: string) => `${open}\n${stepRowsHtml()}\n            ${close}`);
  if (seen === 0) throw new SiteFactsError("site/index.html has no <!--fact:...--> markers");
  return out;
}

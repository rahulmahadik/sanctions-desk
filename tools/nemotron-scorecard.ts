/**
 * The Nemotron scorecard at the top of docs/NEMOTRON.md: step, model, where and why; calls, median time and tokens and
 * the recorded cost per model; the share of calls answered on the laptop; the Brier score of every arm with
 * confidences; the safety-guard results with 95% ranges. Computed from committed files only (see
 * tools/lib/nemotron-scorecard.ts); it calls no service.
 *
 *   npm run nemotron:scorecard             # writes eval/nemotron-scorecard.json, the block in docs/NEMOTRON.md and,
 *                                          # when the deck folder is present on this machine, the deck's copy
 *   npm run nemotron:scorecard -- --check  # exits 1 if the JSON or the block would change (CI)
 *
 * A new exam result in eval/results whose cases carry confidences is added to the calibration table once committed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";
import { BLOCK_RE, buildScorecard, checkStepsAgainstDoc, renderScorecard } from "./lib/nemotron-scorecard.js";

const check = process.argv.includes("--check");
const root = projectRoot();
const card = buildScorecard(root);

const docFile = resolveProjectPath("docs/NEMOTRON.md");
const doc = readFileSync(docFile, "utf8");
checkStepsAgainstDoc(doc);
if (!BLOCK_RE.test(doc)) throw new Error("docs/NEMOTRON.md has no <!-- nemotron-scorecard:start --> block");

let stale = false;
const outFile = resolveProjectPath("eval/nemotron-scorecard.json");
// Formatted as `npm run lint` expects, so --check compares like with like.
const json = formatMarkdown(`${JSON.stringify(card, null, 2)}\n`, outFile);
if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== json) {
  stale = true;
  if (!check) writeFileSync(outFile, json);
}
const next = formatMarkdown(
  doc.replace(
    BLOCK_RE,
    () => `<!-- nemotron-scorecard:start -->\n${renderScorecard(card)}\n<!-- nemotron-scorecard:end -->`,
  ),
  docFile,
);
if (next !== doc) {
  stale = true;
  if (!check) writeFileSync(docFile, next);
}
// The deck reads the same JSON from its own folder, which is not part of the repository.
const deckDir = join(root, "internal", "deck");
if (!check && existsSync(deckDir)) writeFileSync(join(deckDir, "scorecard.json"), json);

if (check && stale) {
  console.error("the Nemotron scorecard is out of date: run npm run nemotron:scorecard");
  process.exit(1);
}
const share = card.local_share;
console.log(
  `${check ? "checked" : "wrote"} eval/nemotron-scorecard.json and the block in docs/NEMOTRON.md: ${card.models.map((m) => `${m.model} ${m.calls}`).join(", ")}; local ${share.local_calls}/${share.all_calls}; ${card.calibration.length} calibration arms; guard ${card.guard.map((g) => `${g.x}/${g.n}`).join(", ")}`,
);

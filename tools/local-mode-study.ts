/**
 * Small study of the fully local mode, not part of the recorded evaluation: held-out v4 (12 cases) run three times
 * with every model step on Nemotron 3.5 Lightning on the laptop and three times in the default mode, by the current
 * system. The runs are made with
 *
 *   npm run exam -- --variant lightning --exam heldout4 --system sys6 --tag a3-local-r1 --out logs/a3   (r1 to r3)
 *   npm run exam -- --variant routed    --exam heldout4 --system sys6 --tag a3-default-r1 --out logs/a3 (r1 to r3)
 *
 * and summarised with
 *
 *   npm run study:local-mode              # exports the runs (studies:export --study local-mode) once all six result
 *                                         # files are in logs/a3, then writes eval/local-mode.json, the block in
 *                                         # docs/NEMOTRON.md, the line in README.md and the item in docs/KNOWN_ISSUES.md
 *   npm run study:local-mode -- --check   # exits 1 if any of them would change (CI)
 *   npm run study:local-mode -- --docs    # rewrites only the doc blocks, from the committed eval/local-mode.json
 *
 * Every figure is read from the exported study runs in eval/studies/local-mode (results.json, trace.jsonl.gz,
 * receipts.jsonl.gz), so a fresh clone and CI compute the same thing. Until all six runs are exported, the blocks say
 * the study is in progress and quote the earlier model-choice study (eval/model-choice.json), labelled as such.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";
import {
  ARMS,
  armOf,
  buildStudy,
  type LocalModeStudy,
  type ModelChoiceArm,
  type Receipt,
  RUNS_PER_ARM,
  type RunFigures,
  renderDocBlock,
  renderKnownIssuesItem,
  renderReadmeLine,
  runFigures,
  type StudyResult,
  type TraceEvent,
} from "./lib/local-mode.js";

const check = process.argv.includes("--check");
const docsOnly = process.argv.includes("--docs");
const outFile = resolveProjectPath("eval/local-mode.json");
const studyDir = resolveProjectPath("eval/studies/local-mode");
const resultsDir = resolveProjectPath("logs/a3");

// Export the runs once all six result files are on this machine (it reads logs/ only and calls nothing live).
if (!check && !docsOnly && existsSync(resultsDir)) {
  const files = readdirSync(resultsDir).filter((f) =>
    /-heldout4-sys\d+-(lightning|routed)-a3-(local|default)-r\d+\.json$/.test(f),
  );
  const tags = new Set(files.map((f) => /(a3-(local|default)-r\d+)\.json$/.exec(f)?.[1]));
  if (tags.size >= ARMS.length * RUNS_PER_ARM)
    execFileSync("npx", ["tsx", resolveProjectPath("tools/studies-export.ts"), "--study", "local-mode"], {
      stdio: "inherit",
    });
  else console.log(`${tags.size} of ${ARMS.length * RUNS_PER_ARM} result files in logs/a3; not exporting yet`);
}

const jsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? gunzipSync(readFileSync(file))
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as T)
    : [];

// The illustrative unit costs (assumptions, not prices) that each run used to work out its own cost figure.
const { costs } = loadConfig();
const units = {
  currency: costs.currency,
  cloudInputPerMillionTokens: costs.cloudInputPerMillionTokens,
  cloudOutputPerMillionTokens: costs.cloudOutputPerMillionTokens,
  localPerMillionTokens: costs.localPerMillionTokens,
};

let study: LocalModeStudy;
if (docsOnly && existsSync(outFile)) {
  study = JSON.parse(readFileSync(outFile, "utf8")) as LocalModeStudy;
} else {
  const runs: RunFigures[] = [];
  const dirs = existsSync(studyDir)
    ? readdirSync(studyDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  for (const id of dirs) {
    const dir = join(studyDir, id);
    const result = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as StudyResult;
    if (!armOf(result)) continue;
    runs.push(
      runFigures(
        id,
        result,
        jsonl<TraceEvent>(join(dir, "trace.jsonl.gz")),
        jsonl<Receipt>(join(dir, "receipts.jsonl.gz")),
      ),
    );
  }
  study = buildStudy(runs, units);
}

// The earlier, smaller measurement of Lightning doing the reasoning, quoted (labelled) until this study is complete.
const choiceFile = resolveProjectPath("eval/model-choice.json");
const choiceArms = existsSync(choiceFile)
  ? (JSON.parse(readFileSync(choiceFile, "utf8")) as { arms: ModelChoiceArm[] }).arms
  : [];
const choice = {
  ultra: choiceArms.find((a) => /^Ultra/.test(a.short)),
  lightning: choiceArms.find((a) => /^Lightning/.test(a.short)),
};

let changed = false;
const json = `${JSON.stringify(study, null, 2)}\n`;
if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== json) {
  changed = true;
  if (!check && !docsOnly) writeFileSync(outFile, json);
}
for (const [path, body] of [
  ["docs/NEMOTRON.md", renderDocBlock(study, choice)],
  ["README.md", renderReadmeLine(study, choice)],
  ["docs/KNOWN_ISSUES.md", renderKnownIssuesItem(study)],
] as const) {
  const target = resolveProjectPath(path);
  const doc = readFileSync(target, "utf8");
  const re = /<!-- local-mode:start -->[\s\S]*?<!-- local-mode:end -->/;
  if (!re.test(doc)) throw new Error(`${path} has no <!-- local-mode:start --> block`);
  const next = formatMarkdown(
    doc.replace(re, () => `<!-- local-mode:start -->\n${body}\n<!-- local-mode:end -->`),
    target,
  );
  if (next !== doc) {
    changed = true;
    if (!check) writeFileSync(target, next);
  }
}
if (check && changed) {
  console.error("the local-mode study summary is out of date: run npm run study:local-mode");
  process.exit(1);
}
console.log(
  `${check ? "checked" : "wrote"} the local-mode study: ${study.status === "complete" ? "complete" : "in progress"}, ${study.runs_found} of ${study.runs_expected} runs exported`,
);

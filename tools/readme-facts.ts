/**
 * One source of truth for the counts that appear in prose. Marked values in README.md and docs/*.md, written as
 * <!--fact:name-->value<!--/fact-->, are replaced with the value computed here from the committed data.
 *
 *   npm run readme:refresh                    # rewrite the marked values
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

const read = (p: string) => JSON.parse(readFileSync(resolveProjectPath(p), "utf8"));
const exam = read("eval/cases/exam.json") as { cases: { group: string; kind?: string }[] };
const heldout = read("eval/cases/heldout.json") as { cases: { expected: string }[] };
const edge = read("eval/edge-cases.json") as { edge_cases: unknown[] };
const factsFile = resolveProjectPath("eval/facts.json");
const saved = existsSync(factsFile) ? (JSON.parse(readFileSync(factsFile, "utf8")) as { tests?: number }) : {};

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

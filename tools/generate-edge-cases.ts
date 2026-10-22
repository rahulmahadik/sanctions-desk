/**
 * Write docs/EDGE_CASES.md from eval/edge-cases.json, so the list the README links to is the list the tests check.
 *
 *   npm run docs:edge-cases
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";

interface Edge {
  id: string;
  area: string;
  what: string;
  expected: string;
  covered_by: string[];
}
const registry = JSON.parse(readFileSync(resolveProjectPath("eval/edge-cases.json"), "utf8")) as { edge_cases: Edge[] };
const areas = [...new Set(registry.edge_cases.map((e) => e.area))];

const lines = [
  "# Edge cases",
  "",
  "Each edge case below has an expected outcome and is checked by an exam case, a test, or both. The list lives in `eval/edge-cases.json`; a test checks that every exam case and test named here exists. Regenerate this page with `npm run docs:edge-cases`.",
  "",
];
for (const area of areas) {
  lines.push(
    `## ${area[0]?.toUpperCase()}${area.slice(1)}`,
    "",
    "| Edge case | Expected | Checked by |",
    "|---|---|---|",
  );
  for (const e of registry.edge_cases.filter((x) => x.area === area)) {
    const by = e.covered_by.map((c) => `\`${c.replace(/^(exam|test):/, "").replace("::", " › ")}\``).join("<br>");
    lines.push(`| ${e.what} | ${e.expected} | ${by} |`);
  }
  lines.push("");
}
writeFileSync(resolveProjectPath("docs/EDGE_CASES.md"), `${lines.join("\n").trimEnd()}\n`);
console.log(`wrote docs/EDGE_CASES.md (${registry.edge_cases.length} edge cases)`);

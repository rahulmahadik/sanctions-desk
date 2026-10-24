/**
 * Count, per exam group, the cases in which the critic found a cited fact that does not exist (a table that is not
 * a table, such as the code-computed comparison block), from the traces of a run, and add it to
 * eval/citation-errors.json so the report can compare runs before and after a change.
 *
 *   npm run citations -- --variant routed --since 2026-10-23T04:52:42 --label "before fixes 1 and 2"
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadExam } from "@sanctions-desk/data";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const variant = flag("--variant") ?? "routed";
const since = flag("--since");
const label = flag("--label");
if (!since || !label) throw new Error("use --since <time> and --label <text>");

const groupOf = new Map(loadExam().cases.map((c) => [c.case_id, c.group]));
const dir = resolveProjectPath(loadConfig().logging.dir);
const byGroup: Record<string, { cases: number; with_citation_error: number }> = {};
for (const name of readdirSync(dir).filter((n) => n.startsWith(`trace-eval-${variant}-`))) {
  const caseId = name.replace(`trace-eval-${variant}-`, "").replace(".jsonl", "");
  const events = readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ts: string; seq: number; agent: string; action: string; output_summary?: string })
    .filter((e) => e.ts >= since);
  const start = events.map((e) => e.seq).lastIndexOf(0);
  const run = events.slice(Math.max(0, start));
  const criticVerdicts = run.filter((e) => e.agent === "critic" && e.action === "judge");
  const group = groupOf.get(caseId);
  if (criticVerdicts.length === 0 || !group) continue;
  const row = byGroup[group] ?? { cases: 0, with_citation_error: 0 };
  row.cases += 1;
  if (criticVerdicts.some((e) => /unknown table|unknown column/.test(e.output_summary ?? "")))
    row.with_citation_error += 1;
  byGroup[group] = row;
}

const file = resolveProjectPath("eval/citation-errors.json");
const store = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { runs: unknown[] }) : { runs: [] };
store.runs = [
  ...(store.runs as Array<{ label: string }>).filter((r) => r.label !== label),
  { label, variant, since, by_group: byGroup },
];
writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
console.log(
  `${label}: ${Object.entries(byGroup)
    .map(([g, r]) => `${g} ${r.with_citation_error}/${r.cases}`)
    .join(", ")}`,
);

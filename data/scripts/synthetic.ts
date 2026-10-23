/**
 * Build the seeded synthetic bank and the 60 exam cases from the committed list sample.
 *
 *   npm run data:synthetic
 *
 * Writes data/synthetic/ (tables as JSON and CSV, the list update, a manifest), eval/cases/exam.json and
 * eval/cases/heldout.json. Add --include-heldout to put the held-out rows into data/synthetic/ as well.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBank,
  loadDataSources,
  TABLES,
  type TableRows,
  writeBank,
  writeExam,
  writeHeldout,
} from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";

const config = loadDataSources();
const dir = resolveProjectPath(config.sample.outputDir);
const tables = {} as Record<string, unknown[]>;
for (const [name, schema] of Object.entries(TABLES)) {
  tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
  snapshots: Array<{ snapshot_id: string }>;
};
const bank = buildBank(
  tables as unknown as TableRows,
  manifest.snapshots.map((s) => s.snapshot_id),
);
// The held-out rows are written only on request, so the committed tables stay exactly what the main exam loaded.
const includeHeldout = process.argv.includes("--include-heldout");
writeBank(resolveProjectPath("data/synthetic"), bank, { includeHeldout });
writeHeldout(resolveProjectPath("eval/cases/heldout.json"), bank);
writeExam(resolveProjectPath("eval/cases/exam.json"), bank);
console.log(JSON.stringify(bank.manifest, null, 1));

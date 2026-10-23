/**
 * Build the seeded synthetic bank and the 60 exam cases from the committed list sample.
 *
 *   npm run data:synthetic
 *
 * Writes data/synthetic/ (tables as JSON and CSV, the list update, a manifest), eval/cases/exam.json and
 * eval/cases/heldout.json and eval/cases/heldout2.json. Add --include-heldout to put the held-out rows into
 * data/synthetic/ as well, or --include-heldout2 to put in the first set's rows and then the second set's.
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
  writeHeldout2,
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
const includeHeldout2 = process.argv.includes("--include-heldout2");
writeBank(resolveProjectPath("data/synthetic"), bank, { includeHeldout, includeHeldout2 });
writeHeldout(resolveProjectPath("eval/cases/heldout.json"), bank);
writeHeldout2(resolveProjectPath("eval/cases/heldout2.json"), bank);
writeExam(resolveProjectPath("eval/cases/exam.json"), bank);
console.log(JSON.stringify(bank.manifest, null, 1));

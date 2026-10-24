/**
 * Build the seeded synthetic bank and the 70 exam cases from the committed list sample.
 *
 *   npm run data:synthetic
 *
 * Writes data/synthetic/ (tables as JSON and CSV, the list update, a manifest), eval/cases/exam.json and
 * eval/cases/heldout.json, eval/cases/heldout2.json, eval/cases/heldout3.json and eval/cases/heldout4.json. Add
 * --include-heldout to put the held-out rows into data/synthetic/ as well, --include-heldout2 to put in the first set's
 * rows and then the second set's, --include-heldout3 to put in all three sets' rows, or --include-heldout4 to put in
 * all four sets' rows, in order.
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
  writeHeldout3,
  writeHeldout4,
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
const includeHeldout3 = process.argv.includes("--include-heldout3");
const includeHeldout4 = process.argv.includes("--include-heldout4");
writeBank(resolveProjectPath("data/synthetic"), bank, {
  includeHeldout,
  includeHeldout2,
  includeHeldout3,
  includeHeldout4,
});
writeHeldout(resolveProjectPath("eval/cases/heldout.json"), bank);
writeHeldout2(resolveProjectPath("eval/cases/heldout2.json"), bank);
writeHeldout3(resolveProjectPath("eval/cases/heldout3.json"), bank);
writeHeldout4(resolveProjectPath("eval/cases/heldout4.json"), bank);
writeExam(resolveProjectPath("eval/cases/exam.json"), bank);
console.log(JSON.stringify(bank.manifest, null, 1));

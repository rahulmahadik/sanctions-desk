/**
 * Build the tiny labelled synthetic customer and alert set that ships with the sample.
 *
 *   npm run data:slice
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSliceBank, loadDataSources, TABLES, type TableRows, writeSliceBank } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";

const config = loadDataSources();
const dir = resolveProjectPath(config.sample.outputDir);
const tables = {} as Record<string, unknown[]>;
for (const [name, schema] of Object.entries(TABLES)) {
  tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
}
const policy = JSON.parse(readFileSync(resolveProjectPath("config/policy.default.json"), "utf8"));

const bank = buildSliceBank(tables as unknown as TableRows, `${config.sample.seed}:bank`, {
  nameSimilarity: policy.matching.nameSimilarityThreshold,
});
const out = writeSliceBank(`${config.sample.outputDir}/bank`, bank);
console.log(`written to ${out}`);
console.log(JSON.stringify(bank.manifest.counts));
for (const c of bank.cases) {
  const a = bank.tables.alert.find((x) => x.alert_id === c.alert_id);
  const cust = bank.tables.customer.find((x) => x.customer_id === c.customer_id);
  console.log(
    `${c.alert_id} ${c.scenario.padEnd(24)} ${String(cust?.full_name).slice(0, 34).padEnd(34)} -> ${a?.entry_id}${a?.entry_id === c.entry_id ? "" : ` (!= ${c.entry_id})`} score ${a?.match_score} expect ${c.expected}`,
  );
}

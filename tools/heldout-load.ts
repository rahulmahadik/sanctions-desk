/**
 * Add the held-out rows to the synthetic bank that is already running, without rebuilding anything.
 *
 *   npm run heldout:load             dry run: what would be added, per table
 *   npm run heldout:load -- --apply  add them
 *
 * What it does when applied:
 *   1. writes the held-out rows after the main rows in data/synthetic (the main rows are not changed; a check
 *      refuses to go on if one of them would be);
 *   2. inserts the held-out rows into the running Postgres bank database (INSERT ... ON CONFLICT DO NOTHING);
 *   3. restarts the payments service so it serves the new payments.
 * It then tells you the two Zetaris statements that refresh the cached payments table. It does not rebuild the
 * semantic layer, and it does not touch access control.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BANKDB_TABLE_ORDER,
  buildBank,
  loadDataSources,
  SYNTHETIC_TABLES,
  TABLES,
  type TableRows,
  writeBank,
  writeHeldout,
} from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";

const apply = process.argv.includes("--apply");
const config = loadDataSources();
const sampleDir = resolveProjectPath(config.sample.outputDir);
const list = {} as Record<string, unknown[]>;
for (const [name, schema] of Object.entries(TABLES)) {
  list[name] = schema.array().parse(JSON.parse(readFileSync(join(sampleDir, `${name}.json`), "utf8")));
}
const manifest = JSON.parse(readFileSync(join(sampleDir, "manifest.json"), "utf8")) as {
  snapshots: Array<{ snapshot_id: string }>;
};
const bank = buildBank(
  list as unknown as TableRows,
  manifest.snapshots.map((s) => s.snapshot_id),
);

type Row = Record<string, string | null>;
const key = (r: Row) => JSON.stringify(r);
const added: Record<string, Row[]> = {};
for (const table of BANKDB_TABLE_ORDER) {
  const main = new Set((bank.tables[table] as Row[]).map(key));
  const all = bank.tablesWithHeldout[table] as Row[];
  // Every main row must still be there, unchanged, and the held-out rows come after them.
  const kept = all.filter((r) => main.has(key(r)));
  if (kept.length !== main.size) throw new Error(`${table}: a main row would change; refusing to go on`);
  added[table] = all.filter((r) => !main.has(key(r)));
}

const sqlValue = (v: string | null): string => (v === null ? "NULL" : `'${v.replaceAll("'", "''")}'`);
const insertsFor = (table: string, rows: Row[]): string[] => {
  const columns = Object.keys(SYNTHETIC_TABLES[table as keyof typeof SYNTHETIC_TABLES].shape);
  return rows.map(
    (r) =>
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => sqlValue(r[c] ?? null)).join(", ")}) ON CONFLICT DO NOTHING;`,
  );
};

console.log(`${apply ? "APPLY" : "DRY RUN"}: held-out rows to add to the bank`);
let total = 0;
for (const table of BANKDB_TABLE_ORDER) {
  const n = added[table]?.length ?? 0;
  total += n;
  console.log(
    `  ${table.padEnd(20)} ${String(n).padStart(3)} rows${n > 0 ? `   e.g. ${Object.values((added[table] as Row[])[0] as Row)[0]}` : ""}`,
  );
}
console.log(`  total ${total} rows; ${bank.heldout.length} cases (${bank.heldout.map((c) => c.case_id).join(", ")})`);
if (!apply) {
  console.log("\nNothing was written. Run again with --apply.");
  process.exit(0);
}

writeBank(resolveProjectPath("data/synthetic"), bank, { includeHeldout: true });
writeHeldout(resolveProjectPath("eval/cases/heldout.json"), bank);
console.log("wrote data/synthetic with the held-out rows after the main rows");

const sql = ["BEGIN;", ...BANKDB_TABLE_ORDER.flatMap((t) => insertsFor(t, added[t] ?? [])), "COMMIT;"].join("\n");
const out = execFileSync(
  "docker",
  ["exec", "-i", "sanctions-bankdb", "psql", "-U", "bank_admin", "-d", "bank", "-v", "ON_ERROR_STOP=1"],
  {
    input: sql,
    encoding: "utf8",
  },
);
console.log(
  `inserted into the bank database (${out.split("\n").filter((l) => l.startsWith("INSERT")).length} statements ran)`,
);
execFileSync("docker", ["restart", "sanctions-payments-api"], { stdio: "ignore" });
console.log("restarted the payments service");
console.log(
  [
    "",
    "Next, refresh the cached payments table in Zetaris (no rebuild, access control untouched):",
    "  npm run zetaris:sql -- zetaris/sql/00_reset_create.sql --only uncache_payments --apply",
    "  npm run zetaris:sql -- zetaris/sql/04_payments_create.sql --only cache_payments --apply",
    "  npm run check:roles",
  ].join("\n"),
);

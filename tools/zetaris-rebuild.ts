/**
 * Rebuild everything the sanctions desk creates in Zetaris, in order, from the committed scripts.
 *
 *   npm run zetaris:rebuild                 primary sources (bank database, payments service)
 *   npm run zetaris:rebuild -- --files      bank tables from the file copy instead
 *   npm run zetaris:rebuild -- --list-state a
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const files = args.includes("--files");
const listState = args.includes("--list-state") ? (args[args.indexOf("--list-state") + 1] ?? "b") : "b";

const sql = (name: string) => ["tools/zetaris-sql.ts", `zetaris/sql/${name}`, "--apply", "--skip-exists"];
const steps: Array<{ label: string; args: string[] }> = [
  { label: "place files", args: ["tools/zetaris-load-files.ts", "--list-state", listState] },
  { label: "reset", args: sql("00_reset_create.sql") },
  { label: "list tables", args: sql("01_lists_create.sql") },
  { label: "bank file copy", args: sql("02_bank_files_create.sql") },
  ...(files
    ? []
    : [
        { label: "bank database", args: sql("03_bankdb_create.sql") },
        { label: "payments service", args: sql("04_payments_create.sql") },
      ]),
  { label: "model", args: sql("05_usl_create.sql") },
  { label: "activate", args: sql(files ? "06_activate_files_create.sql" : "06_activate_create.sql") },
  { label: "data quality", args: sql("07_dq_create.sql") },
  { label: "access", args: sql("08_access_create.sql") },
  { label: "runtime users", args: sql("09_agents_create.sql") },
];

for (const step of steps) {
  console.log(`\n== ${step.label}`);
  const result = spawnSync("npx", ["tsx", ...step.args], { stdio: "inherit", timeout: 20 * 60_000 });
  if (result.status !== 0) {
    console.error(`stopped at "${step.label}"`);
    process.exit(result.status ?? 1);
  }
}
console.log("\nrebuild complete");

// Access Control on the model lives in the interface and a rebuild empties it. Say so loudly instead of letting
// the agents silently run on the fallback credential.
const access = spawnSync("npx", ["tsx", "tools/check-roles.ts"], { stdio: "inherit", timeout: 2 * 60_000 });
if (access.status !== 0) process.exit(access.status ?? 1);

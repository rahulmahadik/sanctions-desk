/**
 * Run a reviewed Zetaris setup script. Without --apply it only lists the statements (dry run).
 *
 *   npm run zetaris:sql -- zetaris/sql/01_sources_create.sql
 *   npm run zetaris:sql -- zetaris/sql/01_sources_create.sql --apply --skip-exists
 *   npm run zetaris:sql -- zetaris/sql/01_sources_select.sql --apply --show
 *
 * The admin key is read from the environment and used here only; the running application never uses it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import { readStatements, runSetup } from "@sanctions-desk/zetaris";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: npm run zetaris:sql -- <script.sql> [--apply] [--skip-exists] [--show] [--only name]");
  process.exit(2);
}
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
// Local credentials: .env, and .env.data for the synthetic bank database and payments service.
for (const name of [".env", ".env.data"]) {
  const envFile = join(projectRoot(), name);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const config = loadConfig();
const statements = readStatements(resolveProjectPath(file)).filter((s) => only === undefined || s.name === only);
const apply = args.includes("--apply");
const show = args.includes("--show");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = join(config.logging.dir, `zetaris-setup-${stamp}.jsonl`);

console.log(`${apply ? "APPLY" : "DRY RUN"} ${file}: ${statements.length} statements (log: ${logFile})`);
const results = await runSetup({
  config,
  statements,
  apply,
  skipExists: args.includes("--skip-exists"),
  logFile,
  onResult: (r, sql) => {
    const detail = r.error ? `  ${r.error}` : r.rows !== undefined ? `  rows=${r.rows}` : "";
    console.log(`${r.outcome.padEnd(14)} ${r.name}${detail}`);
    if (show && r.preview) console.log(`    ${r.preview}`);
    if (!apply)
      console.log(
        `${sql
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`,
      );
  },
});
const failed = results.filter((r) => r.outcome === "failed").length;
console.log(`${results.length} statements, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

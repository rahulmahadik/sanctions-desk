/**
 * Check that the payments table is cached in Zetaris, and cache it again if it is not. A cached REST table is held by
 * the engine and is lost when the engine restarts; without it every read calls the payments service again.
 *
 *   npm run zetaris:cache-check             # report only: lists the statement it would send
 *   npm run zetaris:cache-check -- --apply  # send CACHE TABLE for sanctions_payments.payments_raw, logged
 *
 * Only our own object (sanctions_payments.payments_raw) is touched. The admin key is read from the environment and used
 * here only; the running application never uses it. "Already cached" counts as success. Each run is written to
 * logs/zetaris-setup-<time>.jsonl like every other setup statement.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot } from "@sanctions-desk/shared";
import { runSetup } from "@sanctions-desk/zetaris";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}
const apply = process.argv.includes("--apply");
const config = loadConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const [result] = await runSetup({
  config,
  statements: [{ name: "cache_payments", sql: "CACHE TABLE sanctions_payments.payments_raw" }],
  apply,
  skipExists: true,
  logFile: join(config.logging.dir, `zetaris-setup-${stamp}.jsonl`),
});
if (!apply) console.log("dry run: CACHE TABLE sanctions_payments.payments_raw (use --apply to send it)");
else if (result?.outcome === "applied") console.log("payments table was not cached; it is cached now");
else if (result?.outcome === "skipped_exists") console.log("payments table is already cached");
else {
  console.error(`could not cache the payments table: ${result?.error ?? "no answer"}`);
  process.exit(1);
}
process.exit(0);

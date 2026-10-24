/**
 * Check an exported run from its own files: every receipt's Ed25519 signature, that every model call in the trace
 * has its receipt, that the model the trace names is the model the signed receipt says served the call, which
 * model served how many calls of each step, and that every file matches the hash the run's manifest recorded at
 * export, or differs only by the documented change in eval/runs/HASH-CHANGES.json (npm run evidence:hash-changes).
 *
 *   npm run evidence:verify -- eval/runs/<run-id>
 *   npm run evidence:verify                       every run in eval/runs
 *
 * The signing key is the one inside each receipt unless METERLESS_RECEIPT_PUBLIC_KEY (or config/local.json) pins
 * one; pinning shows who signed, an unpinned key only shows the receipt was not altered.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { describeFileCheck, problemsIn, verifyExportedRun } from "./lib/evidence.js";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const trusted = [...loadConfig().nightshift.receiptPublicKeys];

const given = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const base = resolveProjectPath("eval/runs");
const runs =
  given.length > 0
    ? given.map((g) => resolveProjectPath(g))
    : existsSync(base)
      ? readdirSync(base)
          .filter((n) => existsSync(join(base, n, "run-meta.json")))
          .map((n) => join(base, n))
      : [];
if (runs.length === 0) {
  console.error("no exported runs found; run `npm run evidence:export` first");
  process.exit(2);
}

let failed = 0;
for (const dir of runs) {
  const v = verifyExportedRun(dir, trusted);
  const bad = problemsIn(v);
  failed += bad;
  console.log(`\n${v.runId}: ${v.receipts} receipts, ${v.calls} model calls in the trace`);
  console.log(
    `  signatures: ${v.status.valid_pinned} valid (key pinned), ${v.status.valid_unpinned} valid (key taken from the receipt), ${v.status.invalid} invalid, ${v.status.malformed} malformed`,
  );
  console.log(`  files: ${v.files.map((f) => `${f.file} ${describeFileCheck(f.check)}`).join("; ")}`);
  if (v.missing.length > 0)
    console.log(`  calls with no receipt: ${v.missing.length} (${v.missing.slice(0, 3).join("; ")})`);
  if (v.mismatched.length > 0)
    console.log(`  trace and receipt disagree: ${v.mismatched.length} (${v.mismatched.slice(0, 3).join("; ")})`);
  for (const [agent, row] of [...v.split].sort()) {
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    console.log(
      `  ${agent.padEnd(13)} ${[...row]
        .sort((a, b) => b[1] - a[1])
        .map(([m, n]) => `${m} ${((100 * n) / total).toFixed(1)}% (${n})`)
        .join(", ")}`,
    );
  }
  console.log(bad === 0 ? "  OK" : "  FAILED");
}
process.exit(failed === 0 ? 0 : 1);

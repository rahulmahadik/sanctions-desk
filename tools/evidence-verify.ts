/**
 * Check an exported run from its own files: every receipt's Ed25519 signature, that every model call in the trace
 * has its receipt, that the model the trace names is the model the signed receipt says served the call, and which
 * model served how many calls of each step.
 *
 *   npm run evidence:verify -- eval/runs/<run-id>
 *   npm run evidence:verify                       every run in eval/runs
 *
 * The signing key is the one inside each receipt unless METERLESS_RECEIPT_PUBLIC_KEY (or config/local.json) pins
 * one; pinning shows who signed, an unpinned key only shows the receipt was not altered.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig, resolveProjectPath, verifyReceipt } from "@sanctions-desk/shared";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const trusted = [...loadConfig().nightshift.receiptPublicKeys];

const given = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const base = resolveProjectPath("eval/runs");
const runs =
  given.length > 0
    ? given.map((g) => resolveProjectPath(g))
    : existsSync(base)
      ? readdirSync(base).map((n) => join(base, n))
      : [];
if (runs.length === 0) {
  console.error("no exported runs found; run `npm run evidence:export` first");
  process.exit(2);
}

const lines = (path: string): string[] => gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter(Boolean);

let failed = 0;
for (const dir of runs) {
  const meta = JSON.parse(readFileSync(join(dir, "run-meta.json"), "utf8")) as {
    run_id: string;
    receipts: number;
    events: number;
  };
  const envelopes = new Map<
    string,
    { body: { receipt?: { receipt_id?: string; winning_route?: { model?: string; kind?: string } } } }
  >();
  const status = { valid_pinned: 0, valid_unpinned: 0, invalid: 0, malformed: 0 };
  for (const l of lines(join(dir, "receipts.jsonl.gz"))) {
    const env = JSON.parse(l) as { body: { receipt?: { receipt_id?: string } } };
    status[verifyReceipt(env, trusted).status] += 1;
    if (env.body.receipt?.receipt_id) envelopes.set(env.body.receipt.receipt_id, env as never);
  }

  const split = new Map<string, Map<string, number>>();
  let calls = 0;
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const l of lines(join(dir, "trace.jsonl.gz"))) {
    const e = JSON.parse(l) as {
      case_id: string;
      agent: string;
      action: string;
      model_used?: string;
      receipt?: { receipt_id?: string };
    };
    if (e.action !== "model_answer" || !e.receipt?.receipt_id) continue;
    calls += 1;
    const env = envelopes.get(e.receipt.receipt_id);
    if (!env) {
      missing.push(`${e.case_id} ${e.receipt.receipt_id}`);
      continue;
    }
    const served = env.body.receipt?.winning_route?.model ?? "unknown";
    if (e.model_used && e.model_used !== served)
      mismatched.push(`${e.case_id} ${e.agent}: trace says ${e.model_used}, receipt says ${served}`);
    const row = split.get(e.agent) ?? new Map<string, number>();
    row.set(served, (row.get(served) ?? 0) + 1);
    split.set(e.agent, row);
  }

  const bad = status.invalid + status.malformed + missing.length + mismatched.length;
  failed += bad;
  console.log(`\n${meta.run_id}: ${envelopes.size} receipts, ${calls} model calls in the trace`);
  console.log(
    `  signatures: ${status.valid_pinned} valid (key pinned), ${status.valid_unpinned} valid (key taken from the receipt), ${status.invalid} invalid, ${status.malformed} malformed`,
  );
  if (missing.length > 0) console.log(`  calls with no receipt: ${missing.length} (${missing.slice(0, 3).join("; ")})`);
  if (mismatched.length > 0)
    console.log(`  trace and receipt disagree: ${mismatched.length} (${mismatched.slice(0, 3).join("; ")})`);
  for (const [agent, row] of [...split].sort()) {
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

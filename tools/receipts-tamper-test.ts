/**
 * Show that a signed receipt cannot be changed unnoticed: copy one committed receipt, change one byte of the copy, and
 * verify both against the pinned key. The original passes, the copy fails, and the committed file is unchanged.
 *
 *   npm run receipts:tamper-test
 *   npm run receipts:tamper-test -- eval/runs/<run-id>      take the receipt from that run
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { tamperOneByte } from "./lib/receipt-tamper.js";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const trusted = [...loadConfig().nightshift.receiptPublicKeys];
if (trusted.length === 0) throw new Error("no receipt key is pinned (nightshift.receiptPublicKeys)");

const firstReceipt = (dir: string): string | undefined => {
  const path = join(dir, "receipts.jsonl.gz");
  return existsSync(path) ? gunzipSync(readFileSync(path)).toString("utf8").split("\n").find(Boolean) : undefined;
};
const runs = resolveProjectPath("eval/runs");
const given = process.argv.slice(2).find((a) => !a.startsWith("--"));
// A run of a baseline that calls no model (escalate_all, fuzzy, rules) has no receipts; take the first that has one.
const dir = given
  ? resolveProjectPath(given)
  : (readdirSync(runs)
      .map((n) => join(runs, n))
      .find((d) => firstReceipt(d) !== undefined) ?? runs);
const file = join(dir, "receipts.jsonl.gz");
const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");

const before = sha();
const line = firstReceipt(dir);
if (!line) throw new Error(`no receipt in ${file}`);
const work = mkdtempSync(join(tmpdir(), "receipt-tamper-"));
const copy = join(work, "receipt.json");
writeFileSync(copy, line);
const check = tamperOneByte(readFileSync(copy, "utf8"), trusted);
rmSync(work, { recursive: true, force: true });
const untouched = sha() === before;

console.log(`receipt from ${file.replace(`${resolveProjectPath(".")}/`, "")}`);
console.log(`original:            ${check.before}`);
console.log(`copy, 1 byte changed: ${check.after} (byte ${check.changedAt} of the receipt's JSON)`);
console.log(`committed file:      ${untouched ? "unchanged" : "CHANGED"}`);
const pass = check.before === "valid_pinned" && check.after !== "valid_pinned" && untouched;
console.log(pass ? "PASS: the change was caught" : "FAIL");
process.exit(pass ? 0 : 1);

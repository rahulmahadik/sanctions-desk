/**
 * Verify every signed receipt committed under eval/ against the pinned Nightshift key, whatever the folder layout
 * (exported runs, studies, single reviews), and write the counts to eval/receipts-check.json. The counts in the docs
 * are written from this file (npm run readme:refresh).
 *
 *   npm run receipts:check
 */
import { writeFileSync } from "node:fs";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { receiptsLine, scanReceipts } from "./lib/receipts-scan.js";

const trusted = [...loadConfig().nightshift.receiptPublicKeys];
if (trusted.length === 0) throw new Error("no receipt key is pinned (nightshift.receiptPublicKeys)");

const result = scanReceipts(trusted);
writeFileSync(resolveProjectPath("eval/receipts-check.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`${receiptsLine(result)} (${result.files} files)`);
process.exit(result.valid_pinned === result.receipts ? 0 : 1);

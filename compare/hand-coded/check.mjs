// Checks that the hand-coded version gives the same guarantees: hidden column, refused table, audit, retry, cache.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createAccess, ROLES } from "./access.mjs";
import { createAudit } from "./audit.mjs";
import { cached } from "./cache.mjs";
import { withRetry } from "./retry.mjs";

const dir = mkdtempSync(`${tmpdir()}/hand-`);
const audit = createAudit(dir);
const access = createAccess(audit);
const rows = [{ identifier_id: "I1", id_number: "AB123456", id_type: "passport" }];
assert.equal("id_number" in access.read("evidence", "customer_identifier", rows)[0], false);
assert.equal("id_number" in access.read("reviewer", "customer_identifier", rows)[0], true);
ROLES.eval.tables = ["alert"];
assert.throws(() => access.read("eval", "customer", rows), /may not read/);
const log = readFileSync(audit.file, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
assert.deepEqual(
  log.map((l) => [l.identity, l.outcome]),
  [
    ["evidence", "ok"],
    ["reviewer", "ok"],
    ["eval", "refused"],
  ],
);

let calls = 0;
assert.equal(
  await withRetry("flaky", async () => (++calls < 3 ? Promise.reject(new Error("down")) : "up"), { delayMs: 1 }),
  "up",
);
await assert.rejects(
  withRetry("dead", async () => Promise.reject(new Error("down")), { tries: 2, delayMs: 1 }),
  /failed after 2 tries/,
);

let loads = 0;
const load = async () => {
  loads += 1;
  return [1];
};
assert.equal((await cached(dir, "k", 60000, load)).cache, "miss");
assert.equal((await cached(dir, "k", 60000, load)).cache, "hit");
assert.equal(loads, 1);
console.log("hand-coded checks: all passed");

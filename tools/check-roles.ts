/**
 * Check that the three runtime identities can really read the model, and fail loudly when they cannot.
 *
 *   npm run check:roles
 *
 * Access Control on a Unified Semantic Layer is set in the Zetaris interface; there is no SQL or REST call to
 * read or write it, and rebuilding the model empties it. This asks the platform itself: each identity's token
 * runs one read on the model, and the answer says whether the access is in place.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const { zetaris } = config;

const identities = [
  ["evidence", zetaris.tokens.evidence],
  ["reviewer", zetaris.tokens.reviewer],
  ["eval", zetaris.tokens.eval],
] as const;
const table = `${zetaris.namespace}.${zetaris.usl}.customer`;

async function read(token: string): Promise<{ status: number; msg: string }> {
  const res = await fetch(`${zetaris.restUrl}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Org-ID": zetaris.orgId, "content-type": "application/json" },
    body: JSON.stringify({
      queryId: randomUUID(),
      sql: `SELECT COUNT(*) FROM ${table}`,
      source: "SqlEditor",
      limit: 1,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let msg = "";
  try {
    msg = (JSON.parse(text) as { msg?: string }).msg ?? "";
  } catch {
    // an answer with rows has no message
  }
  return { status: res.status, msg: msg.split("\n")[0]?.slice(0, 160) ?? "" };
}

let failed = 0;
for (const [name, token] of identities) {
  if (!token) {
    console.log(`${name}: no token set`);
    failed += 1;
    continue;
  }
  const r = await read(token.reveal());
  const ok = r.status === 200;
  console.log(`${name}: ${ok ? "can read the model" : `REFUSED (${r.msg || `HTTP ${r.status}`})`}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`
ROLE ACCESS CHECK FAILED for ${failed} of ${identities.length} identities.
The app will keep working through the visible admin-key fallback, but the agents are not on their own credentials.
Access Control on ${zetaris.namespace}.${zetaris.usl} is empty or not applied. Rebuilding the model empties it.
Set it in the Zetaris interface (Data Product > Unified Semantic Layer > Access Control: assign the three roles or
users and tick SELECT on every table, then set the id_number mask for role_evidence_agent), and run this again.
See docs/ZETARIS.md.`);
  process.exit(1);
}
console.log("role access check passed");

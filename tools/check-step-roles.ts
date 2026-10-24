/**
 * Check the optional per-step Zetaris identities against the platform itself: each step's token must read every
 * table its role was granted, and Zetaris must refuse it a table it was not granted. The calls go straight to the
 * Zetaris REST API, past the application's own allow-lists, so a refusal can only come from Zetaris. The critic is
 * also asked for identifier numbers, which its role must not reach.
 *
 *   npm run check:step-roles                   prints each check
 *   npm run check:step-roles -- --write        also writes zetaris/step-roles-check.json (no tokens, no secrets)
 */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { httpRequest, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { USL_STEP_ROLES } from "@sanctions-desk/zetaris";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { zetaris: z } = loadConfig();
const Q = `${z.namespace}.${z.usl}`;
const keyOf: Record<string, keyof typeof z.tokens> = {
  ZETARIS_TOKEN_OWNERSHIP: "ownership",
  ZETARIS_TOKEN_CRITIC: "critic",
  ZETARIS_TOKEN_MEMORY: "memory",
  ZETARIS_TOKEN_DOCUMENT: "document",
  ZETARIS_TOKEN_RESCREEN: "rescreen",
};
/** Tables a step must be refused: one it plainly does not need, and for the critic the identifier tables. */
const refusedFor = (role: string, granted: readonly string[]): string[] => {
  const probe = ["account", "customer_alias", "customer"].find((t) => !granted.includes(t)) as string;
  return role === "role_critic_agent" ? [probe, "customer_identifier", "list_identifier"] : [probe];
};
/** The platform's wording when a signed-in user lacks a permission (as in the Zetaris client). */
const DENIED = /does not have access|not permitted|permission denied/i;
const mask = (s: string) => s.replace(/[A-Za-z0-9_-]{32,}/g, "[masked]");

async function run(token: string, sql: string): Promise<{ status: number; message: string }> {
  const res = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Org-ID": z.orgId },
    body: { queryId: randomUUID(), sql, source: "SqlEditor", limit: 1 },
    timeoutMs: z.requestTimeoutMs,
  });
  let message = "";
  try {
    message = String((JSON.parse(res.text) as { msg?: unknown }).msg ?? "");
  } catch {
    // not a JSON message
  }
  return { status: res.status, message: mask(message.split("\n")[0]?.slice(0, 200) ?? "") };
}

interface Check {
  role: string;
  table: string;
  sql: string;
  expect: "read" | "refused";
  status: number;
  message: string;
  pass: boolean;
}
const checks: Check[] = [];
let missing = 0;
for (const r of USL_STEP_ROLES) {
  const token = z.tokens[keyOf[r.tokenEnv] as keyof typeof z.tokens];
  if (!token) {
    console.log(`${r.role}: no token (${r.tokenEnv}); the step reads as the evidence identity`);
    missing += 1;
    continue;
  }
  const probes: Array<[string, string, Check["expect"]]> = [
    ...r.tables.map((t): [string, string, Check["expect"]] => [t, `SELECT COUNT(*) AS n FROM ${Q}.${t}`, "read"]),
    ...refusedFor(r.role, r.tables).map((t): [string, string, Check["expect"]] => [
      t,
      t.endsWith("_identifier") ? `SELECT \`id_number\` FROM ${Q}.${t}` : `SELECT COUNT(*) AS n FROM ${Q}.${t}`,
      "refused",
    ]),
  ];
  for (const [table, sql, expect] of probes) {
    const { status, message } = await run(token.reveal(), sql);
    const pass = expect === "read" ? status === 200 : status !== 200 && DENIED.test(message);
    checks.push({ role: r.role, table, sql, expect, status, message, pass });
    console.log(
      `${pass ? "PASS" : "FAIL"} ${r.role} ${expect === "read" ? "reads" : "is refused"} ${table}: HTTP ${status}${message ? ` ${message}` : ""}`,
    );
  }
}
if (process.argv.includes("--write"))
  writeFileSync(
    resolveProjectPath("zetaris/step-roles-check.json"),
    `${JSON.stringify({ checked_at: new Date().toISOString(), checks }, null, 2)}\n`,
  );
const failed = checks.filter((c) => !c.pass).length;
console.log(
  `${checks.length - failed} of ${checks.length} checks passed${missing ? `; ${missing} step identities not set up` : ""}`,
);
process.exit(failed > 0 ? 1 : 0);

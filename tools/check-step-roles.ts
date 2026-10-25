/**
 * Check the optional per-step Zetaris identities against the platform itself: each step's token must read every
 * table its role was granted, and Zetaris must refuse it a table it was not granted. The calls go straight to the
 * Zetaris REST API, past the application's own allow-lists, so a refusal can only come from Zetaris. Each step also
 * tries to write to a granted table with statements that touch no row even if allowed (`WHERE 1 = 0`), and the row
 * count is read before and after.
 *
 *   npm run check:step-roles -- --dry-run      prints every statement it would send, sends nothing
 *   npm run check:step-roles                   prints each check
 *   npm run check:step-roles -- --write        also writes zetaris/step-roles-check.json (no tokens, no secrets)
 */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { httpRequest, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { USL_STEP_ROLES, USL_TABLE_ORDER } from "@sanctions-desk/zetaris";

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
/** Tables a step must be refused: every table of the semantic layer it was not granted. */
const refusedFor = (granted: readonly string[]): string[] => USL_TABLE_ORDER.filter((t) => !granted.includes(t));
const dryRun = process.argv.includes("--dry-run");
/** The platform's wording when a signed-in user lacks a permission (as in the Zetaris client). */
const DENIED = /does not have access|does not have privileges|not permitted|permission denied/i;
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
  expect: "read" | "refused" | "write refused";
  status: number;
  message: string;
  pass: boolean;
}
const checks: Check[] = [];
let missing = 0;
for (const r of USL_STEP_ROLES) {
  const token = z.tokens[keyOf[r.tokenEnv] as keyof typeof z.tokens];
  if (!token && !dryRun) {
    console.log(`${r.role}: no token (${r.tokenEnv}); the step reads as the evidence identity`);
    missing += 1;
    continue;
  }
  const probes: Array<[string, string, Check["expect"]]> = [
    ...r.tables.map((t): [string, string, Check["expect"]] => [t, `SELECT COUNT(*) AS n FROM ${Q}.${t}`, "read"]),
    ...refusedFor(r.tables).map((t): [string, string, Check["expect"]] => [
      t,
      t.endsWith("_identifier") ? `SELECT \`id_number\` FROM ${Q}.${t}` : `SELECT COUNT(*) AS n FROM ${Q}.${t}`,
      "refused",
    ]),
  ];
  const target = r.tables[0] as string;
  const writes: Array<[string, string, Check["expect"]]> = [
    [target, `INSERT INTO ${Q}.${target} SELECT * FROM ${Q}.${target} WHERE 1 = 0`, "write refused"],
    [target, `DELETE FROM ${Q}.${target} WHERE 1 = 0`, "write refused"],
  ];
  if (dryRun || !token) {
    for (const [table, sql, expect] of [...probes, ...writes])
      console.log(`would send as ${r.role} (${expect}, ${table}): ${sql}`);
    continue;
  }
  const countOf = async (): Promise<string> => {
    const res = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.reveal()}`, "X-Org-ID": z.orgId },
      body: { queryId: randomUUID(), sql: `SELECT COUNT(*) AS n FROM ${Q}.${target}`, source: "SqlEditor", limit: 1 },
      timeoutMs: z.requestTimeoutMs,
    });
    if (res.status !== 200) return `HTTP ${res.status}`;
    // Only the count: the rest of the answer (time used) differs on every call.
    return String((JSON.parse(res.text) as { data?: string[][] }).data?.[0]?.[0] ?? "no count");
  };
  const before = await countOf();
  for (const [table, sql, expect] of [...probes, ...writes]) {
    const { status, message } = await run(token.reveal(), sql);
    const pass =
      expect === "read"
        ? status === 200
        : expect === "write refused"
          ? status !== 200
          : status !== 200 && DENIED.test(message);
    checks.push({ role: r.role, table, sql, expect, status, message, pass });
    console.log(
      `${pass ? "PASS" : "FAIL"} ${r.role} ${expect === "read" ? "reads" : expect === "refused" ? "is refused" : "cannot write"} ${table}: HTTP ${status}${message ? ` ${message}` : ""}`,
    );
  }
  // A write that was refused changes nothing; the count is the evidence either way.
  const after = await countOf();
  const same = before === after;
  checks.push({
    role: r.role,
    table: target,
    sql: `row count of ${target} before and after the write statements`,
    expect: "write refused",
    status: same ? 200 : 0,
    message: same ? `row count unchanged (${before})` : `row count changed (${before} to ${after})`,
    pass: same,
  });
  console.log(`${same ? "PASS" : "FAIL"} ${r.role} ${target}: row count ${same ? "unchanged" : "changed"}`);
}
if (dryRun) process.exit(0);
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

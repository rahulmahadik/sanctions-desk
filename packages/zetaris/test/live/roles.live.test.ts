import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The three runtime identities against a live Zetaris. Skipped unless LIVE_TESTS=1 and the three tokens are set.
 *   npm run test:live
 *
 * Raw REST calls are used on purpose: the application's own SQL guard would hide what the platform itself does.
 */
const live = process.env.LIVE_TESTS === "1";
if (live && existsSync(".env")) process.loadEnvFile(".env");

const base = process.env.ZETARIS_REST_URL ?? "http://localhost:8888/api/v1.0";
const org = process.env.ZETARIS_ORG_ID ?? "1";
const tokens = {
  evidence: process.env.ZETARIS_TOKEN_EVIDENCE,
  reviewer: process.env.ZETARIS_TOKEN_REVIEWER,
  eval: process.env.ZETARIS_TOKEN_EVAL,
} as const;
const ready = live && Object.values(tokens).every(Boolean);
const identities = Object.keys(tokens) as Array<keyof typeof tokens>;

async function run(
  token: string | undefined,
  sql: string,
): Promise<{ status: number; msg: string; rows?: Array<Array<string | null>> }> {
  const res = await fetch(`${base}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Org-ID": org, "content-type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 3 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let msg = text;
  let rows: Array<Array<string | null>> | undefined;
  try {
    const parsed = JSON.parse(text) as { msg?: string; data?: Array<Array<string | null>> };
    msg = parsed.msg ?? "";
    rows = parsed.data;
  } catch {
    // not JSON
  }
  return { status: res.status, msg: msg.slice(0, 300), rows };
}

describe.skipIf(!ready)("runtime identities on a live Zetaris", () => {
  it.each(identities)("%s signs in with its own token", async (who) => {
    expect((await run(tokens[who], "SELECT 1")).status).toBe(200);
  });

  it.each(identities)("%s cannot create, drop or grant anything", async (who) => {
    for (const sql of [
      "CREATE LIGHTNING DATABASE sanctions_probe_denied",
      "DROP LIGHTNING DATABASE sanctions_lists",
      "GRANT SELECT ON ALL TO ROLE 'role_eval'",
    ]) {
      const r = await run(tokens[who], sql);
      expect(r.status).toBe(400);
      expect(r.msg).toContain("not permitted");
    }
  });

  it.each(identities)("%s cannot read tables outside the model", async (who) => {
    const r = await run(tokens[who], "SELECT COUNT(*) FROM sanctions_lists.list_entry_raw");
    expect(r.status).toBe(400);
  });

  const model = "lightning.metastore.sanctions.screening_usl";

  it.each(identities)("%s can read every table of the model with its own token", async (who) => {
    for (const t of [
      "business_definition",
      "list_entry",
      "customer",
      "customer_identifier",
      "payment",
      "alert",
      "disposition",
    ]) {
      const r = await run(tokens[who], `SELECT COUNT(*) FROM ${model}.${t}`);
      expect(r.status, `${who} ${t}: ${r.msg}`).toBe(200);
    }
  });

  it("the reviewer sees identifier numbers in full", async () => {
    const r = await run(tokens.reviewer, `SELECT id_number FROM ${model}.customer_identifier LIMIT 1`);
    expect(r.status).toBe(200);
    expect(r.rows?.[0]?.[0]).toBeTruthy();
  });

  // Column Access HIDEs id_number for the evidence role, but this platform edition still returns it in clear, so the
  // application masks it itself. Expected to fail until the platform enforces the policy; then remove `fails`.
  it.fails("the evidence role does not receive id_number in clear", async () => {
    const r = await run(tokens.evidence, `SELECT id_number FROM ${model}.customer_identifier LIMIT 1`);
    const value = r.rows?.[0]?.[0];
    expect(r.status !== 200 || value === null || value === undefined || /^\W+$/.test(String(value))).toBe(true);
  });
});

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

async function run(token: string | undefined, sql: string): Promise<{ status: number; msg: string }> {
  const res = await fetch(`${base}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Org-ID": org, "content-type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 3 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let msg = text;
  try {
    msg = (JSON.parse(text) as { msg?: string }).msg ?? text;
  } catch {
    // an answer with rows is not an error message
  }
  return { status: res.status, msg: msg.slice(0, 300) };
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

  // On the platform version used for development the model's tables are refused to these identities even though
  // table-level grants exist (the access check names the table without the model). This test records that, so it
  // starts failing, and shows the identities can be used, the day the platform allows it.
  it.each(identities)("%s is refused the model's tables by the platform (known limitation)", async (who) => {
    const r = await run(tokens[who], "SELECT COUNT(*) FROM lightning.metastore.sanctions.screening_usl.customer");
    expect(r.status).toBe(400);
    expect(r.msg).toContain("does not have access to USL");
  });
});

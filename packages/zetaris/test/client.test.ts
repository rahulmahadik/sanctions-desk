import { describe, expect, it } from "vitest";
import { createZetarisClient, identityOfPolicyRole, type QueryRecord } from "../src/client.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const T = "lightning.metastore.sanctions.screening_usl.customer";
const tokens = {
  ZETARIS_API_KEY: "admin-key-1",
  ZETARIS_TOKEN_EVIDENCE: "evidence-token-1",
  ZETARIS_TOKEN_REVIEWER: "reviewer-token-1",
};

type Answer = (sql: string) => { status?: number; body: unknown };

function setup(env: Record<string, string>, answer: Answer = () => ({ body: rowsOf(["a", "b"], [["1", null]]) })) {
  const api = fakeZetaris(answer);
  const records: QueryRecord[] = [];
  const client = createZetarisClient({
    config: testConfig(env),
    fetchImpl: api.fetchImpl,
    onQuery: (r) => records.push(r),
  });
  client.setAllowedTables([T]);
  return { api, client, records };
}

describe("createZetarisClient", () => {
  it("sends the role's own token and maps rows, keeping SQL NULL as null", async () => {
    const { api, client, records } = setup(tokens);
    const result = await client.query("evidence", `SELECT a, b FROM ${T}`);
    expect(api.sent[0]?.headers.Authorization).toBe("Bearer evidence-token-1");
    expect(api.sent[0]?.headers["X-Org-ID"]).toBe("1");
    expect(api.sent[0]?.body.limit).toBe(200);
    expect(result.objects).toEqual([{ a: "1", b: null }]);
    expect(result).toMatchObject({
      status: "ok",
      row_count: 1,
      token_source: "role",
      cache_hit: false,
      kind: "select",
    });
    expect(result.query_id).toBe(api.sent[0]?.body.queryId);
    expect(records).toHaveLength(1);
    expect(records[0]?.sql_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses each role's own token and labels the admin key as a fallback", async () => {
    const { api, client } = setup(tokens);
    await client.query("reviewer", `SELECT a FROM ${T}`);
    await client.query("eval", `SELECT a FROM ${T}`);
    expect(api.sent.map((s) => s.headers.Authorization)).toEqual(["Bearer reviewer-token-1", "Bearer admin-key-1"]);
    expect(client.tokenSource("evidence")).toBe("role");
    expect(client.tokenSource("eval")).toBe("fallback");
  });

  it("fails when a role has no token and there is no fallback", async () => {
    const { client } = setup({});
    expect(client.tokenSource("evidence")).toBe("missing");
    await expect(client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ type: "config_missing" });
  });

  it("blocks statements the guard refuses without sending anything", async () => {
    const { api, client, records } = setup(tokens);
    await expect(client.query("evidence", "SELECT 1; SELECT 2")).rejects.toMatchObject({ type: "guard_blocked" });
    await expect(client.query("evidence", "DROP TABLE x")).rejects.toMatchObject({ type: "guard_blocked" });
    await expect(client.query("evidence", "SELECT * FROM other.table")).rejects.toMatchObject({
      type: "guard_blocked",
    });
    expect(api.sent).toHaveLength(0);
    expect(records.map((r) => [r.status, r.blocked_by])).toEqual([
      ["blocked", "multiple_statements"],
      ["blocked", "not_read_only"],
      ["blocked", "table_not_allowed"],
    ]);
  });

  it("reports Zetaris errors with the first line of the message", async () => {
    const { client, records } = setup(tokens, () => ({
      status: 400,
      body: { msg: "[TABLE_OR_VIEW_NOT_FOUND] nope\nmore detail" },
    }));
    await expect(client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({
      type: "query_failed",
      recoverable: false,
    });
    expect(records[0]).toMatchObject({ status: "error", error: "[TABLE_OR_VIEW_NOT_FOUND] nope" });
  });

  it("treats 5xx as recoverable and 401/403 as not", async () => {
    const down = setup(tokens, () => ({ status: 503, body: "busy" }));
    await expect(down.client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ recoverable: true });
    const denied = setup(tokens, () => ({ status: 403, body: { msg: "denied" } }));
    await expect(denied.client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ recoverable: false });
  });

  it("rejects an answer that is not the expected JSON", async () => {
    const notJson = setup(tokens, () => ({ body: "<html>" }));
    await expect(notJson.client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({
      type: "bad_response",
    });
    const noData = setup(tokens, () => ({ body: { ok: true } }));
    await expect(noData.client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ type: "bad_response" });
  });

  it("reports network failures and records them", async () => {
    const records: QueryRecord[] = [];
    const client = createZetarisClient({
      config: testConfig(tokens),
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      onQuery: (r) => records.push(r),
    });
    client.setAllowedTables([T]);
    await expect(client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ type: "network" });
    expect(records[0]?.status).toBe("error");
  });

  it("keeps the allow-list case-insensitive and de-duplicated", () => {
    const { client } = setup(tokens);
    client.setAllowedTables([T.toUpperCase(), T]);
    expect(client.allowedTables()).toEqual([T]);
  });
});

describe("identityOfPolicyRole", () => {
  it("maps policy role names to identities and rejects unknown ones", () => {
    expect(identityOfPolicyRole("role_evidence_agent")).toBe("evidence");
    expect(identityOfPolicyRole("role_reviewer")).toBe("reviewer");
    expect(identityOfPolicyRole("role_eval")).toBe("eval");
    expect(() => identityOfPolicyRole("role_admin")).toThrow(/unknown access role/);
  });
});

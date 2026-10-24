import { describe, expect, it } from "vitest";
import { createZetarisClient, type QueryRecord } from "../src/client.js";
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
    await expect(client.query("evidence", "SELECT 1 FROM other.users")).rejects.toMatchObject({
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

describe("a role token the platform refuses", () => {
  const withFallback = () => {
    const config = testConfig(tokens);
    return { ...config, zetaris: { ...config.zetaris, fallbackOnDenied: true } };
  };

  it("falls back to the admin key once, labels it, and stops trying the role token", async () => {
    let calls = 0;
    const api = fakeZetaris(() => {
      calls += 1;
      return calls === 1
        ? { status: 400, body: { msg: "User 'X' does not have access to USL: m.s.customer" } }
        : { body: rowsOf(["a"], [["1"]]) };
    });
    const records: QueryRecord[] = [];
    const client = createZetarisClient({
      config: withFallback(),
      fetchImpl: api.fetchImpl,
      onQuery: (r) => records.push(r),
    });
    client.setAllowedTables([T]);
    const result = await client.query("evidence", `SELECT a FROM ${T}`);
    expect(result.token_source).toBe("fallback");
    expect(api.sent.map((s) => s.headers.Authorization)).toEqual(["Bearer evidence-token-1", "Bearer admin-key-1"]);
    expect(records.map((r) => [r.token_source, r.status])).toEqual([
      ["role", "error"],
      ["fallback", "ok"],
    ]);
    await client.query("evidence", `SELECT a FROM ${T}`);
    expect(api.sent[2]?.headers.Authorization).toBe("Bearer admin-key-1");
    expect(client.tokenSource("evidence")).toBe("fallback");
  });

  it("does not use the admin key when the fallback is switched off", async () => {
    const api = fakeZetaris(() => ({ status: 400, body: { msg: "User 'X' does not have access to USL: a.b" } }));
    const config = testConfig(tokens);
    const off = createZetarisClient({
      config: { ...config, zetaris: { ...config.zetaris, fallbackOnDenied: false } },
      fetchImpl: api.fetchImpl,
    });
    off.setAllowedTables([T]);
    await expect(off.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ type: "query_failed" });
    expect(api.sent).toHaveLength(1);
  });

  it("does not retry other failures with the admin key", async () => {
    const api = fakeZetaris(() => ({ status: 400, body: { msg: "syntax error near x" } }));
    const client = createZetarisClient({ config: testConfig(tokens), fetchImpl: api.fetchImpl });
    client.setAllowedTables([T]);
    await expect(client.query("evidence", `SELECT a FROM ${T}`)).rejects.toMatchObject({ type: "query_failed" });
    expect(api.sent).toHaveLength(1);
  });
});

describe("a client limited to one agent's tables and columns", () => {
  const OTHER = "lightning.metastore.sanctions.screening_usl.customer_identifier";
  const scope = { agent: "critic", tables: ["customer"], denyColumns: ["id_number"] };

  it("allows its own tables, even when the credential could read more", async () => {
    const { api, client } = setup({ ZETARIS_API_KEY: "admin-key-1" });
    client.setAllowedTables([T, OTHER]);
    await client.scoped(scope).query("evidence", `SELECT a FROM ${T}`);
    expect(api.sent).toHaveLength(1);
  });

  it("blocks another table and a denied column before anything is sent, and records the block", async () => {
    const { api, client, records } = setup({ ZETARIS_API_KEY: "admin-key-1" });
    client.setAllowedTables([T, OTHER]);
    const critic = client.scoped(scope);
    await expect(critic.query("evidence", `SELECT a FROM ${OTHER}`)).rejects.toMatchObject({
      type: "guard_blocked",
      details: { code: "agent_scope" },
    });
    await expect(critic.query("evidence", `SELECT id_number FROM ${T}`)).rejects.toThrow(
      /may not name the column id_number/,
    );
    expect(api.sent).toHaveLength(0);
    expect(records.map((r) => [r.status, r.blocked_by])).toEqual([
      ["blocked", "agent_scope"],
      ["blocked", "agent_scope"],
    ]);
  });

  it("gives an agent with no tables no data at all, but the unscoped client still works", async () => {
    const { api, client } = setup({ ZETARIS_API_KEY: "admin-key-1" });
    const none = client.scoped({ agent: "decision", tables: [], denyColumns: [] });
    await expect(none.query("evidence", `SELECT a FROM ${T}`)).rejects.toThrow(/may not read customer/);
    await client.query("evidence", `SELECT a FROM ${T}`);
    expect(api.sent).toHaveLength(1);
  });
});

describe("per-step identities", () => {
  const TABLE = "lightning.metastore.sanctions.screening_usl.beneficial_owner";
  const SQL = `SELECT \`ownership_id\` FROM ${TABLE}`;
  const run = async (env: Record<string, string>) => {
    const { fetchImpl, sent } = fakeZetaris(() => ({ body: rowsOf(["ownership_id"], [["O1"]]) }));
    const records: QueryRecord[] = [];
    const client = createZetarisClient({
      config: testConfig({ ZETARIS_API_KEY: "admin", ZETARIS_TOKEN_EVIDENCE: "ev", ...env }),
      fetchImpl,
      onQuery: (r) => records.push(r),
    });
    client.setAllowedTables([TABLE]);
    await client.query("ownership", SQL);
    return { records, auth: sent.map((s) => s.headers.Authorization) };
  };

  it("reads as the evidence identity when a step has no token of its own", async () => {
    const { records, auth } = await run({});
    expect(records.map((r) => r.role)).toEqual(["evidence"]);
    expect(auth).toEqual(["Bearer ev"]);
  });

  it("uses the step's own identity and token when one is set", async () => {
    const { records, auth } = await run({ ZETARIS_TOKEN_OWNERSHIP: "own" });
    expect(records.map((r) => [r.role, r.token_source])).toEqual([["ownership", "role"]]);
    expect(auth).toEqual(["Bearer own"]);
  });
});

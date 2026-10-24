import { sha256Hex } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { auditToken, fetchQueryHistory, matchAudit } from "../src/audit.js";
import { fakeZetaris, testConfig } from "./helpers.js";

const entry = (id: string, sql: string, status = "Success") => ({ id, sql, status, time: "2026-10-23T01:00:00Z" });

describe("fetchQueryHistory", () => {
  it("reads the history with the given token and indexes it by query id", async () => {
    const api = fakeZetaris(() => ({ body: [entry("q1", "SELECT 1"), entry("q2", "SELECT 2", "Error")] }));
    const history = await fetchQueryHistory(testConfig(), "secret-token-value", api.fetchImpl);
    expect([...history.keys()]).toEqual(["q1", "q2"]);
    expect(api.sent).toHaveLength(1);
  });

  it("fails clearly on a refusal or an answer in the wrong shape", async () => {
    const refused = fakeZetaris(() => ({ status: 401, body: { msg: "no" } }));
    await expect(fetchQueryHistory(testConfig(), "t", refused.fetchImpl)).rejects.toMatchObject({
      type: "query_failed",
    });
    const notJson = fakeZetaris(() => ({ body: "<html>" }));
    await expect(fetchQueryHistory(testConfig(), "t", notJson.fetchImpl)).rejects.toMatchObject({
      type: "bad_response",
    });
    const wrong = fakeZetaris(() => ({ body: [{ id: 5 }] }));
    await expect(fetchQueryHistory(testConfig(), "t", wrong.fetchImpl)).rejects.toMatchObject({ type: "bad_response" });
  });
});

describe("matchAudit", () => {
  const history = new Map([
    ["ok", entry("ok", "SELECT 1")],
    ["changed", entry("changed", "SELECT 2")],
    ["failed", entry("failed", "SELECT 3", "Error")],
  ]);

  it("matches a statement that is in the history, unchanged and successful", () => {
    const r = matchAudit([{ query_id: "ok", sql_hash: sha256Hex("SELECT 1") }], history);
    expect(r).toMatchObject({ available: true, checked: 1, matched: 1, problems: 0 });
    expect(r.findings[0]).toMatchObject({ status: "matched", zetaris_status: "Success" });
  });

  it("reports a statement that differs, one that failed at the source and one that is missing", () => {
    const r = matchAudit(
      [
        { query_id: "changed", sql_hash: sha256Hex("SELECT 99") },
        { query_id: "failed", sql_hash: sha256Hex("SELECT 3") },
        { query_id: "gone", sql_hash: sha256Hex("SELECT 4") },
      ],
      history,
    );
    expect(r.findings.map((f) => f.status)).toEqual(["statement_differs", "failed_at_source", "not_in_history"]);
    expect(r).toMatchObject({ checked: 3, matched: 0, problems: 3 });
  });
});

describe("matchAudit on a statement kept with its document number replaced", () => {
  const ran = "SELECT COUNT(*) AS n FROM t WHERE customer_id = 'CUST-1' AND id_number = 'ZP1234567'";
  const kept =
    "SELECT COUNT(*) AS n FROM t WHERE customer_id = 'CUST-1' AND id_number = '<document number, sha256 0123456789abcdef>'";
  const lookup = { query_id: "doc", sql: kept, sql_hash: sha256Hex(kept), redacted: true };

  it("matches it when everything but the number is the same, and says the number was not compared", () => {
    const r = matchAudit([lookup], new Map([["doc", entry("doc", ran)]]));
    expect(r).toMatchObject({ checked: 1, matched: 1, problems: 0 });
    expect(r.findings[0]?.status).toBe("matched_redacted");
  });

  it("still reports a statement that differs anywhere else", () => {
    const other = ran.replace("CUST-1", "CUST-2");
    expect(matchAudit([lookup], new Map([["doc", entry("doc", other)]])).findings[0]?.status).toBe("statement_differs");
    const injected = ran.replace("'ZP1234567'", "'ZP1' OR '1'='1'");
    expect(matchAudit([lookup], new Map([["doc", entry("doc", injected)]])).findings[0]?.status).toBe(
      "statement_differs",
    );
  });

  it("does not treat a statement as redacted unless the record says so", () => {
    const plain = { query_id: "doc", sql: kept, sql_hash: sha256Hex(kept) };
    expect(matchAudit([plain], new Map([["doc", entry("doc", ran)]])).findings[0]?.status).toBe("statement_differs");
  });
});

describe("auditToken", () => {
  it("prefers the role's own token, then the labelled fallback, else none", () => {
    expect(auditToken(testConfig({ ZETARIS_TOKEN_REVIEWER: "r", ZETARIS_API_KEY: "a" }))).toBe("r");
    expect(auditToken(testConfig({ ZETARIS_API_KEY: "a" }))).toBe("a");
    expect(auditToken(testConfig())).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { ACCESS_FIX_STEPS, accessFails, checkRoleAccess, describeAccessFailure } from "../src/access.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const tokens = { ZETARIS_TOKEN_EVIDENCE: "e-1", ZETARIS_TOKEN_REVIEWER: "r-1", ZETARIS_TOKEN_EVAL: "v-1" };

describe("checkRoleAccess", () => {
  it("is ok when every identity can read the model with its own token", async () => {
    const api = fakeZetaris(() => ({ body: rowsOf(["count(1)"], [["305"]]) }));
    const results = await checkRoleAccess(testConfig(tokens), { fetchImpl: api.fetchImpl });
    expect(results.slice(0, 3).map((r) => [r.role, r.state])).toEqual([
      ["evidence", "ok"],
      ["reviewer", "ok"],
      ["eval", "ok"],
    ]);
    // The five per-step identities have no token here: reported, not a failure.
    expect(results.slice(3).map((r) => [r.role, r.state, r.optional])).toEqual([
      ["ownership", "no_token", true],
      ["critic", "no_token", true],
      ["memory", "no_token", true],
      ["document", "no_token", true],
      ["rescreen", "no_token", true],
    ]);
    expect(results.some(accessFails)).toBe(false);
    expect(api.sent.map((s) => s.headers.Authorization)).toEqual(["Bearer e-1", "Bearer r-1", "Bearer v-1"]);
    expect(api.sent[0]?.body.sql).toContain("screening_usl.customer");
  });

  it("names who is refused and what the platform said, and who has no token", async () => {
    const api = fakeZetaris(() => ({
      status: 400,
      body: { msg: "User 'AGENT' does not have access to USL: metastore.sanctions.customer\nmore" },
    }));
    const results = await checkRoleAccess(testConfig({ ZETARIS_TOKEN_EVIDENCE: "e-1" }), { fetchImpl: api.fetchImpl });
    expect(results[0]).toMatchObject({ role: "evidence", state: "refused" });
    expect(results[0]?.detail).toContain("does not have access to USL");
    expect(results[0]?.detail).not.toContain("more");
    expect(results.slice(1, 3).map((r) => r.state)).toEqual(["no_token", "no_token"]);
    expect(results.filter(accessFails).map((r) => r.role)).toEqual(["evidence", "reviewer", "eval"]);
  });

  it("reports an unreachable platform separately from a refusal", async () => {
    const fetchImpl = async () => {
      throw new Error("connection refused");
    };
    const results = await checkRoleAccess(testConfig(tokens), { fetchImpl });
    expect(results.slice(0, 3).every((r) => r.state === "unreachable")).toBe(true);
  });

  it("explains the fix in steps, without any token", async () => {
    const text = describeAccessFailure([
      { role: "evidence", state: "refused", detail: "does not have access" },
      { role: "reviewer", state: "ok" },
    ]);
    expect(text).toContain("evidence (refused: does not have access)");
    expect(text).not.toContain("reviewer (");
    for (const step of ACCESS_FIX_STEPS) expect(text).toContain(step);
    expect(text).toContain("npm run check:roles");
    expect(text).not.toMatch(/e-1|r-1/);
  });
});

describe("checkRoleAccess and the per-step identities", () => {
  const steps = {
    ...tokens,
    ZETARIS_TOKEN_OWNERSHIP: "o-1",
    ZETARIS_TOKEN_CRITIC: "c-1",
    ZETARIS_TOKEN_MEMORY: "m-1",
    ZETARIS_TOKEN_DOCUMENT: "d-1",
    ZETARIS_TOKEN_RESCREEN: "s-1",
  };

  it("has each step identity read a table it was granted, with its own token", async () => {
    const api = fakeZetaris(() => ({ body: rowsOf(["count(1)"], [["1"]]) }));
    const results = await checkRoleAccess(testConfig(steps), { fetchImpl: api.fetchImpl });
    expect(results.map((r) => r.state)).toEqual(Array(8).fill("ok"));
    const sent = api.sent.slice(3).map((s) => [s.headers.Authorization, s.body.sql]);
    expect(sent.map(([a]) => a)).toEqual(["Bearer o-1", "Bearer c-1", "Bearer m-1", "Bearer d-1", "Bearer s-1"]);
    expect(sent[0]?.[1]).toContain(".beneficial_owner");
    expect(sent[2]?.[1]).toContain(".disposition");
    expect(sent[3]?.[1]).toContain(".customer_identifier");
  });

  it("fails the check when a step identity with a token is refused", async () => {
    // The critic's check reads its first granted table, business_definition, which no other identity reads here.
    const api = fakeZetaris((sql) =>
      sql.includes(".business_definition")
        ? { status: 400, body: { msg: "User 'AGENT_CRITIC' does not have privileges" } }
        : { body: rowsOf(["count(1)"], [["1"]]) },
    );
    const results = await checkRoleAccess(testConfig(steps), { fetchImpl: api.fetchImpl });
    expect(results.filter(accessFails).map((r) => r.role)).toEqual(["critic"]);
    expect(describeAccessFailure(results)).toContain("critic (refused");
  });
});

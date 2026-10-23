import { describe, expect, it } from "vitest";
import { ACCESS_FIX_STEPS, checkRoleAccess, describeAccessFailure } from "../src/access.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const tokens = { ZETARIS_TOKEN_EVIDENCE: "e-1", ZETARIS_TOKEN_REVIEWER: "r-1", ZETARIS_TOKEN_EVAL: "v-1" };

describe("checkRoleAccess", () => {
  it("is ok when every identity can read the model with its own token", async () => {
    const api = fakeZetaris(() => ({ body: rowsOf(["count(1)"], [["305"]]) }));
    const results = await checkRoleAccess(testConfig(tokens), { fetchImpl: api.fetchImpl });
    expect(results.map((r) => [r.role, r.state])).toEqual([
      ["evidence", "ok"],
      ["reviewer", "ok"],
      ["eval", "ok"],
    ]);
    expect(api.sent.map((s) => s.headers.Authorization)).toEqual(["Bearer e-1", "Bearer r-1", "Bearer v-1"]);
    expect(api.sent[0]?.body.sql).toContain("screening_usl.customer");
  });

  it("names who is refused and what the platform said, and who has no token", async () => {
    const api = fakeZetaris((sql) => ({
      status: 400,
      body: { msg: "User 'AGENT' does not have access to USL: metastore.sanctions.customer\nmore" },
    }));
    const results = await checkRoleAccess(testConfig({ ZETARIS_TOKEN_EVIDENCE: "e-1" }), { fetchImpl: api.fetchImpl });
    expect(results[0]).toMatchObject({ role: "evidence", state: "refused" });
    expect(results[0]?.detail).toContain("does not have access to USL");
    expect(results[0]?.detail).not.toContain("more");
    expect(results.slice(1).map((r) => r.state)).toEqual(["no_token", "no_token"]);
  });

  it("reports an unreachable platform separately from a refusal", async () => {
    const fetchImpl = async () => {
      throw new Error("connection refused");
    };
    const results = await checkRoleAccess(testConfig(tokens), { fetchImpl });
    expect(results.every((r) => r.state === "unreachable")).toBe(true);
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

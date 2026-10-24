import { MAX_REASON_LENGTH, MIN_REASON_LENGTH, sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import { createFallbackRulesGenerator, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/openapi.js";
import { ReasonSchema } from "../src/routes/decisions.js";
import { makeApp } from "./helpers.js";

/**
 * One reason-length rule. The human decision step owns it (MIN_REASON_LENGTH, MAX_REASON_LENGTH); the route schemas
 * enforce the same numbers at the edge and the API description states them.
 */

const REASON_ROUTES = [
  "/cases/{alertId}/decision",
  "/cases/{alertId}/second-approval",
  "/cases/{alertId}/reopen",
  "/autonomy/kill-switch",
];

async function sampleApp() {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return makeApp({
    env: { SAMPLE_MODE: "true" },
    zetaris,
    generator: createFallbackRulesGenerator(sampleRules),
    authMode: "demo",
  });
}

describe("the reason a person gives", () => {
  it("has the same limits in the route schemas and the API description as in the human decision step", () => {
    expect(ReasonSchema.minLength).toBe(MIN_REASON_LENGTH);
    expect(ReasonSchema.maxLength).toBe(MAX_REASON_LENGTH);
    for (const path of REASON_ROUTES) {
      const route = ROUTES.find((r) => r.method === "post" && r.path === path);
      const reason = (route?.body?.properties as Record<string, unknown> | undefined)?.reason;
      expect(reason, path).toEqual({ type: "string", minLength: MIN_REASON_LENGTH, maxLength: MAX_REASON_LENGTH });
    }
  });

  it("is refused at the edge when too short or too long, naming the field; the longest allowed reason goes through", async () => {
    const ctx = await sampleApp();
    const alertId = examCase(loadExam(), "fp_dob_exact_name_0").alert_id ?? "";
    await ctx.app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: "run-reason" } });
    const view = (await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/human` })).json();
    const decide = (reason: string) =>
      ctx.app.inject({
        method: "POST",
        url: `/cases/${alertId}/decision`,
        headers: { "x-demo-user": "analyst_demo" },
        payload: { action: "approve", reason, record_hash: view.record_hash },
      });
    const tooShort = "x".repeat(MIN_REASON_LENGTH - 1);
    const tooLong = "x".repeat(MAX_REASON_LENGTH + 1);
    const blankPadding = `${" ".repeat(MIN_REASON_LENGTH)}${tooShort}`;
    for (const reason of [tooShort, tooLong, blankPadding]) {
      const res = await decide(reason);
      expect(res.statusCode, JSON.stringify(reason.length)).toBe(400);
      const issues = res.json().error.details.issues as Array<{ path: string }>;
      expect(issues.map((i) => i.path)).toContain("reason");
    }
    expect((await decide("x".repeat(MAX_REASON_LENGTH))).statusCode).toBe(201);
  });
});

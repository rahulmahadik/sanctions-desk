import { createHash } from "node:crypto";
import { sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import {
  createFallbackRulesGenerator,
  createMcpHandler,
  hashToken,
  loadConfig,
  MCP_TOOL_NAMES,
  resolveProjectPath,
  type UsersFile,
} from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * The MCP server against the real API with sign-in on: every tool call carries the caller's own token, so the API's
 * sign-in and roles decide what it may do, and no tool can record a decision, so four-eyes cannot be bypassed.
 */
const tok = (seed: string): string => `sd_${createHash("sha256").update(seed).digest("base64url").slice(0, 32)}`;
const TOKENS = { viewer: tok("mcp-viewer-0123456789abcdef"), analyst: tok("mcp-analyst-0123456789abcdef") };
const users: UsersFile = {
  users: [
    { id: "vic", role: "viewer", token_format: "sd_192" as const, token_sha256: hashToken(TOKENS.viewer) },
    { id: "ann", role: "analyst", token_format: "sd_192" as const, token_sha256: hashToken(TOKENS.analyst) },
  ],
};
const alert = examCase(loadExam(), "fp_dob_exact_name_0").alert_id ?? "";

async function mcpAs(token?: string) {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  const { app } = await makeApp({
    env: { SAMPLE_MODE: "true" },
    zetaris,
    generator: createFallbackRulesGenerator(sampleRules),
    authMode: "on",
    users,
  });
  // The handler's HTTP calls go to the app in-process, headers and all.
  const handle = createMcpHandler({
    baseUrl: "http://desk.test",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    fetchImpl: async (url, init) => {
      const res = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: url.replace("http://desk.test", ""),
        headers: init?.headers as Record<string, string>,
        ...(init?.body ? { payload: init.body as string } : {}),
      });
      return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (
      (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      }
    ).result;
  return { call };
}

describe("the MCP server goes through the API's sign-in and roles", () => {
  it("refuses a caller with no token", async () => {
    const { call } = await mcpAs();
    expect((await call("list_alerts")).isError).toBe(true);
  });

  it("lets a viewer read the queue but not start a review", async () => {
    const { call } = await mcpAs(TOKENS.viewer);
    expect((await call("list_alerts")).isError).toBeFalsy();
    const review = await call("review_alert", { alert_id: alert });
    expect(review.isError).toBe(true);
  });

  it("lets an analyst start a review and returns a recommendation, never a decision", async () => {
    const { call } = await mcpAs(TOKENS.analyst);
    const review = await call("review_alert", { alert_id: alert });
    expect(review.isError).toBeFalsy();
    expect(review.content[0]?.text).toContain("recommendation");
  });

  it("has no tool that records a decision, so the four-eyes rules cannot be reached through it", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      ["explain_policy", "get_case", "get_case_file", "list_alerts", "review_alert", "verify_receipt"].sort(),
    );
  });
});

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGenerator, loadConfig, type ModelAttempt, verifyReceipt } from "../../src/index.js";

/**
 * Live smoke test against the real Nightshift runtime and the local Ollama backup.
 * Skipped unless LIVE_TESTS=1, so CI and fresh clones stay green without any service running.
 *   npm run test:live
 */
const live = process.env.LIVE_TESTS === "1";
if (live && existsSync(".env")) process.loadEnvFile(".env");

describe.skipIf(!live)("generator against live services", () => {
  const config = loadConfig();
  const request = { prompt: "Reply with the single word: ready", maxTokens: 1024, temperature: 0 };
  const noBackup = { ...config, ollama: { ...config.ollama, baseUrl: "http://127.0.0.1:1/v1" } };

  it("answers through Nightshift with a pinned mode and reports which model and route answered", async () => {
    const attempts: ModelAttempt[] = [];
    const generate = buildGenerator(noBackup, { onAttempt: (a) => attempts.push(a) });
    const result = await generate({ ...request, lane: "fast" });
    expect(result.provider).toBe("nightshift");
    expect(result.requestedModel).toBe(config.nightshift.models.fast);
    expect(result.requestedModel).not.toBe("meterless/auto");
    expect(result.text.toLowerCase()).toContain("ready");
    expect(result.routedModel.length).toBeGreaterThan(0);
    expect(["local", "cloud"]).toContain(result.routeKind);
    expect(attempts.at(-1)).toMatchObject({ provider: "nightshift", outcome: "ok" });
  }, 120_000);

  it("returns a signed receipt that verifies", async () => {
    const generate = buildGenerator(noBackup);
    const result = await generate({ ...request, prompt: `${request.prompt} ${Date.now()}`, lane: "fast" });
    expect(result.receipt).toBeDefined();
    expect(["valid_unpinned", "valid_pinned"]).toContain(result.receipt?.verification);
    expect(verifyReceipt(result.receiptEnvelope).status).toMatch(/^valid/);
  }, 120_000);

  it("falls back to Ollama when Nightshift is unreachable", async () => {
    const generate = buildGenerator({
      ...config,
      nightshift: { ...config.nightshift, baseUrl: "http://127.0.0.1:1/v1" },
    });
    const result = await generate(request);
    expect(result.provider).toBe("ollama");
    expect(result.fellBackFrom?.[0]?.provider).toBe("nightshift");
    expect(result.text.toLowerCase()).toContain("ready");
  }, 120_000);
});

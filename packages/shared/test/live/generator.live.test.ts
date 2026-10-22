import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGenerator, loadConfig } from "../../src/index.js";

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

  it("answers through Nightshift and reports which model and route answered", async () => {
    const generate = buildGenerator({ ...config, ollama: { ...config.ollama, baseUrl: "http://127.0.0.1:1/v1" } });
    const result = await generate({ ...request, lane: "fast" });
    expect(result.provider).toBe("nightshift");
    expect(result.text.toLowerCase()).toContain("ready");
    expect(result.routedModel.length).toBeGreaterThan(0);
    expect(["local", "cloud"]).toContain(result.routeKind);
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

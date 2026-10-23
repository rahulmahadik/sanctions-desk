import { describe, expect, it } from "vitest";
import { createNightshiftGenerator, isRateLimited, Secret } from "../src/index.js";
import { jsonResponse, nightshiftReply, stubFetch } from "./helpers.js";

/** App identities for reasoning and for the guard, and the wait after a 429. */
const modes = { fast: "meterless/fast", deep: "meterless/deep", judge: "meterless/judge" };

function generator(
  responses: Parameters<typeof stubFetch>[0],
  extra: Partial<Parameters<typeof createNightshiftGenerator>[0]> = {},
) {
  const stub = stubFetch(responses);
  const waits: number[] = [];
  let clock = 1_000_000;
  const generate = createNightshiftGenerator({
    baseUrl: `http://nightshift-${Math.random().toString(36).slice(2)}.test/v1`,
    token: new Secret("rt-test-token-0123456789"),
    appId: "main-app",
    apps: { reasoning: "app-reasoning", guard: "app-guard" },
    rateLimit: { retries: 3, baseDelayMs: 100 },
    scope: "user",
    models: modes,
    timeoutMs: 1000,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    fetchImpl: stub.fetchImpl,
    ...extra,
  });
  const apps = () => stub.calls.map((c) => (c.init.headers as Record<string, string>)["meterless-app"]);
  return { generate, apps, waits, calls: stub.calls };
}

describe("app identities", () => {
  it("sends a reasoning request under the reasoning identity and a guard request under the guard identity", async () => {
    const g = generator([
      jsonResponse(nightshiftReply("a")),
      jsonResponse(nightshiftReply("b")),
      jsonResponse(nightshiftReply("c")),
    ]);
    const reasoning = await g.generate({ prompt: "x", lane: "deep", identity: "reasoning" });
    await g.generate({ prompt: "x", lane: "fast", identity: "guard" });
    await g.generate({ prompt: "x", lane: "fast" });
    expect(g.apps()).toEqual(["app-reasoning", "app-guard", "main-app"]);
    expect(reasoning.app).toBe("app-reasoning");
  });

  it("falls back to the main identity when none is configured", async () => {
    const g = generator([jsonResponse(nightshiftReply("a"))], { apps: undefined });
    const r = await g.generate({ prompt: "x", identity: "guard" });
    expect(g.apps()).toEqual(["main-app"]);
    expect(r.app).toBe("main-app");
  });
});

describe("after a 429", () => {
  it("recognises a 429 and the runtime's 502 that wraps one", () => {
    expect(isRateLimited(429, "")).toBe(true);
    expect(isRateLimited(502, '429: {"status":429,"title":"Too Many Requests"}')).toBe(true);
    expect(isRateLimited(502, "bad gateway")).toBe(false);
    expect(isRateLimited(400, "Too Many Requests")).toBe(false);
    expect(isRateLimited(200, "")).toBe(false);
  });

  it("waits, with a doubling pause, and sends the same request again", async () => {
    const g = generator([
      jsonResponse({ error: { message: "429" } }, 429),
      jsonResponse({ error: { message: '429: {"title":"Too Many Requests"}' } }, 502),
      jsonResponse(nightshiftReply("done")),
    ]);
    const r = await g.generate({ prompt: "x", lane: "deep" });
    expect(r.text).toBe("done");
    expect(g.waits).toEqual([100, 200]);
    expect(g.calls).toHaveLength(3);
  });

  it("gives up after the configured number of retries and lets the caller's own fallback take over", async () => {
    const g = generator(
      Array.from({ length: 6 }, () => jsonResponse({ error: { message: "429" } }, 429)),
      { rateLimit: { retries: 2, baseDelayMs: 50 } },
    );
    await expect(g.generate({ prompt: "x" })).rejects.toThrow(/429/);
    expect(g.calls).toHaveLength(3);
    expect(g.waits).toEqual([50, 100]);
  });

  it("holds back the next call for the rest of the wait, so a burst does not keep tripping the limit", async () => {
    const base = `http://shared-${Math.random().toString(36).slice(2)}.test/v1`;
    const stub = stubFetch([
      jsonResponse({}, 429),
      jsonResponse(nightshiftReply("a")),
      jsonResponse(nightshiftReply("b")),
    ]);
    const waits: number[] = [];
    let clock = 0;
    const make = () =>
      createNightshiftGenerator({
        baseUrl: base,
        token: new Secret("rt-test-token-0123456789"),
        appId: "main-app",
        rateLimit: { retries: 1, baseDelayMs: 1000 },
        scope: "user",
        models: modes,
        timeoutMs: 1000,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
        now: () => clock,
        fetchImpl: stub.fetchImpl,
      });
    await make()({ prompt: "x" });
    await make()({ prompt: "y" });
    // The first generator waited 1000 ms after the 429 and its retry went through; nothing else had to wait.
    expect(waits).toEqual([1000]);
  });

  it("does not wait for an error that is not a rate limit", async () => {
    const g = generator([jsonResponse({ error: { message: "boom" } }, 500)]);
    await expect(g.generate({ prompt: "x" })).rejects.toThrow();
    expect(g.waits).toEqual([]);
  });
});

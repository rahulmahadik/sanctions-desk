import { hashToken, loadConfig, type UsersFile } from "@sanctions-desk/shared";
import { createZetarisClient } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * Rate limits: a fixed window per caller for anything that is not a read, a lower one for the routes that start a
 * review, and a cap on reviews running at once. The clock is injected so a window can be ended without waiting.
 */

const WINDOW_MS = 60_000;
const limits = (over: Record<string, unknown> = {}) => ({
  server: {
    rateLimit: {
      enabled: true,
      windowMs: WINDOW_MS,
      writesPerWindow: 3,
      reviewsPerWindow: 2,
      reviewsInFlight: 4,
      busyRetryAfterSeconds: 7,
      ...over,
    },
  },
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

type App = Awaited<ReturnType<typeof makeApp>>["app"];
const write = (app: App, remoteAddress = "10.0.0.1", headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/guard/outbound", payload: {}, remoteAddress, headers });
const review = (app: App, payload: Record<string, unknown> = {}, remoteAddress = "10.0.0.1") =>
  app.inject({ method: "POST", url: "/run", payload, remoteAddress });

function expectLimited(res: Awaited<ReturnType<typeof write>>) {
  expect(res.statusCode).toBe(429);
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  expect(res.json()).toMatchObject({ status: "error", error: { type: "rate_limited", recoverable: true } });
  expect(typeof res.json().error.message).toBe("string");
}

describe("rate limits on writes", () => {
  it("refuses the request after the limit with 429 and Retry-After", async () => {
    const c = clock();
    const { app } = await makeApp({ overrides: limits(), now: c.now });
    for (let i = 0; i < 3; i++) expect((await write(app)).statusCode).toBe(400);
    const over = await write(app);
    expectLimited(over);
    expect(over.headers["retry-after"]).toBe("60");
    c.advance(15_000);
    expect((await write(app)).headers["retry-after"]).toBe("45");
  });

  it("leaves another caller unaffected", async () => {
    const { app } = await makeApp({ overrides: limits(), now: clock().now });
    for (let i = 0; i < 4; i++) await write(app, "10.0.0.1");
    expectLimited(await write(app, "10.0.0.1"));
    expect((await write(app, "10.0.0.2")).statusCode).toBe(400);
  });

  it("starts a new window once the old one ends", async () => {
    const c = clock();
    const { app } = await makeApp({ overrides: limits(), now: c.now });
    for (let i = 0; i < 3; i++) await write(app);
    expectLimited(await write(app));
    c.advance(WINDOW_MS - 1);
    expectLimited(await write(app));
    c.advance(1);
    for (let i = 0; i < 3; i++) expect((await write(app)).statusCode).toBe(400);
    expectLimited(await write(app));
  });

  it("never limits reads or /health", async () => {
    const { app } = await makeApp({ overrides: limits({ writesPerWindow: 1 }), now: clock().now });
    await write(app);
    expectLimited(await write(app));
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.1" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/policy", remoteAddress: "10.0.0.1" })).statusCode).toBe(200);
    }
  });

  it("is off when the configuration says so", async () => {
    const { app } = await makeApp({ overrides: limits({ enabled: false, writesPerWindow: 1 }), now: clock().now });
    for (let i = 0; i < 5; i++) expect((await write(app)).statusCode).toBe(400);
  });
});

describe("rate limits on reviews", () => {
  it("gives POST /run and POST /policy/whatif the lower limit", async () => {
    const { app } = await makeApp({ overrides: limits({ writesPerWindow: 100 }), now: clock().now });
    expect((await review(app)).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/policy/whatif", payload: {}, remoteAddress: "10.0.0.1" })).statusCode,
    ).not.toBe(429);
    expectLimited(await review(app));
    expectLimited(await app.inject({ method: "POST", url: "/policy/whatif", payload: {}, remoteAddress: "10.0.0.1" }));
    // Other writes still have room, and another caller can still start a review.
    expect((await write(app)).statusCode).toBe(400);
    expect((await review(app, {}, "10.0.0.2")).statusCode).toBe(400);
  });

  it("counts a review as a write too", async () => {
    const { app } = await makeApp({
      overrides: limits({ writesPerWindow: 2, reviewsPerWindow: 10 }),
      now: clock().now,
    });
    await review(app);
    await review(app);
    expectLimited(await write(app));
  });
});

describe("rate limits per signed-in user", () => {
  const users: UsersFile = {
    users: [
      { id: "ann", role: "analyst", token_sha256: hashToken("rl-ann-0123456789abcdef") },
      { id: "abe", role: "analyst", token_sha256: hashToken("rl-abe-0123456789abcdef") },
    ],
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it("counts each user on their own, wherever they connect from", async () => {
    const { app } = await makeApp({ overrides: limits(), now: clock().now, authMode: "on", users });
    for (let i = 0; i < 3; i++) await write(app, `10.0.0.${i + 1}`, as("rl-ann-0123456789abcdef"));
    expectLimited(await write(app, "10.0.0.9", as("rl-ann-0123456789abcdef")));
    expect((await write(app, "10.0.0.1", as("rl-abe-0123456789abcdef"))).statusCode).toBe(400);
  });

  it("counts by address in demo mode, so changing the demo user does not reset the count", async () => {
    const { app } = await makeApp({
      overrides: limits(),
      now: clock().now,
      authMode: "demo",
      env: { SAMPLE_MODE: "true" },
    });
    const demo = ["analyst_demo", "approver_demo", "admin_demo", "analyst_demo"];
    for (const user of demo.slice(0, 3)) await write(app, "10.0.0.1", { "x-demo-user": user });
    expectLimited(await write(app, "10.0.0.1", { "x-demo-user": demo[3] as string }));
  });
});

describe("reviews in flight", () => {
  /** A data service that answers only when released, so reviews stay running. */
  function heldZetaris() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = loadConfig({ env: {} });
    const zetaris = createZetarisClient({
      config,
      offline: true,
      fetchImpl: async () => {
        await gate;
        return new Response('{"msg":"no data service in this test"}', { status: 503 });
      },
    });
    return { zetaris, release };
  }

  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };

  it("refuses the fifth concurrent review and frees the slots when the reviews end, even in failure", async () => {
    const held = heldZetaris();
    const { app, bus } = await makeApp({
      overrides: limits({ writesPerWindow: 100, reviewsPerWindow: 100 }),
      now: clock().now,
      zetaris: held.zetaris,
    });
    const ids = ["RL-1", "RL-2", "RL-3", "RL-4"];
    const running = ids.map((id, i) => review(app, { alert_id: id, run_id: `run-${id}` }, `10.0.1.${i}`));
    // Each review has started (and holds its slot) once its first event is out.
    await waitFor(() => ids.every((id) => bus.hasRun(`run-${id}`)));

    const fifth = await review(app, { alert_id: "RL-5" }, "10.0.1.9");
    expectLimited(fifth);
    expect(fifth.headers["retry-after"]).toBe("7");

    held.release();
    const ended = await Promise.all(running);
    for (const res of ended) expect(res.statusCode).toBeGreaterThanOrEqual(500);

    // All four slots are free again.
    const again = await Promise.all(["RL-6", "RL-7", "RL-8", "RL-9"].map((id) => review(app, { alert_id: id })));
    for (const res of again) expect(res.statusCode).not.toBe(429);
  });

  it("frees the slot when a review is refused before it starts", async () => {
    const { app } = await makeApp({
      overrides: limits({ reviewsInFlight: 1, writesPerWindow: 100, reviewsPerWindow: 100 }),
      now: clock().now,
    });
    for (let i = 0; i < 3; i++) expect((await review(app)).statusCode).toBe(400);
    for (let i = 0; i < 3; i++) expect((await review(app, { alert_id: `RL-${i}` })).statusCode).not.toBe(429);
  });
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DependencyReport } from "../src/probes.js";
import { makeApp } from "./helpers.js";

const report = (overrides: Partial<DependencyReport> = {}): DependencyReport => ({
  nightshift: { state: "ok", latencyMs: 3 },
  ollama: { state: "ok", latencyMs: 4 },
  zetaris: { state: "not_configured" },
  ...overrides,
});

describe("GET /health", () => {
  it("reports liveness without touching any dependency", async () => {
    const { app } = await makeApp({
      prober: async () => {
        throw new Error("liveness must not probe dependencies");
      },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "@sanctions-desk/api", sample_mode: false });
    expect(typeof res.json().version).toBe("string");
  });

  it("sets security headers and a request id", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a safe caller request id and replaces an unsafe one", async () => {
    const { app } = await makeApp();
    const safe = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "trace-abc_1.2" } });
    expect(safe.headers["x-request-id"]).toBe("trace-abc_1.2");
    const unsafe = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "bad id\nwith newline" } });
    expect(unsafe.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers unknown routes with a structured 404", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/nope?x=1" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: "error", error: { type: "validation", recoverable: false } });
    expect(res.json().error.message).not.toContain("x=1");
  });
});

describe("GET /health/dependencies", () => {
  it("is ok when Nightshift answers", async () => {
    const { app } = await makeApp({ prober: async () => report() });
    const res = await app.inject({ method: "GET", url: "/health/dependencies" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("is degraded (still 200) when only the Ollama backup answers", async () => {
    const { app } = await makeApp({ prober: async () => report({ nightshift: { state: "unreachable" } }) });
    const res = await app.inject({ method: "GET", url: "/health/dependencies" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("degraded");
  });

  it("is unavailable (503) when no model provider answers", async () => {
    const { app } = await makeApp({
      prober: async () => report({ nightshift: { state: "unauthorized" }, ollama: { state: "unreachable" } }),
    });
    const res = await app.inject({ method: "GET", url: "/health/dependencies" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("unavailable");
  });
});

describe("POST /run", () => {
  it("answers a valid request with a structured not_implemented error and writes a trace", async () => {
    const { app, logDir } = await makeApp({ env: { METERLESS_RUNTIME_TOKEN: "rt-never-in-output-123456" } });
    const res = await app.inject({
      method: "POST",
      url: "/run",
      payload: { run_id: "run-m0", alert_id: "A-0001", options: { sample_mode: true } },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body).toMatchObject({
      run_id: "run-m0",
      status: "error",
      trace_id: "run-m0",
      error: { type: "not_implemented", recoverable: false },
    });
    expect(body.decision).toBeUndefined();
    expect(body.execution_time_seconds).toBeGreaterThanOrEqual(0);

    const traceFile = join(logDir, "trace-run-m0.jsonl");
    expect(existsSync(traceFile)).toBe(true);
    const lines = readFileSync(traceFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ agent: "system", action: "run_rejected", input_summary: "alert_id=A-0001" });
    expect(JSON.stringify(body) + lines.join("")).not.toContain("rt-never-in-output");
  });

  it("generates a run id when none is given", async () => {
    const { app, logDir } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/run", payload: { alert: { customer: "C-1" } } });
    expect(res.statusCode).toBe(501);
    expect(res.json().run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(logDir)).toHaveLength(1);
  });

  it("rejects a request with neither alert_id nor alert", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/run", payload: { options: {} } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error", error: { type: "validation" } });
    expect(res.json().error.details.issues.length).toBeGreaterThan(0);
  });

  it("rejects a run id that could escape the log directory, and writes nothing", async () => {
    const { app, logDir } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/run", payload: { alert_id: "A-1", run_id: "../../etc/x" } });
    expect(res.statusCode).toBe(400);
    expect(existsSync(logDir)).toBe(false);
  });

  it("rejects malformed JSON and an empty body", async () => {
    const { app } = await makeApp();
    const bad = await app.inject({ method: "POST", url: "/run", headers: { "content-type": "application/json" }, payload: "{oops" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.type).toBe("validation");
    const empty = await app.inject({ method: "POST", url: "/run" });
    expect(empty.statusCode).toBe(400);
  });

  it("enforces the configured body size limit", async () => {
    const { app } = await makeApp({ overrides: { server: { bodyLimitBytes: 64 } } });
    const res = await app.inject({ method: "POST", url: "/run", payload: { alert_id: "A".repeat(500) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.message).toBe("request body is too large");
  });
});

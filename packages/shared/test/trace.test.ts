import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError, createTraceLogger, makeRedactor, RunIdSchema, RunRequestSchema, readTrace } from "../src/index.js";
import { tempDir } from "./helpers.js";

const fixedNow = () => new Date("2026-10-23T01:02:03.000Z");

describe("createTraceLogger", () => {
  it("appends schema-valid JSONL lines with increasing sequence numbers", () => {
    const dir = tempDir();
    const trace = createTraceLogger({ runId: "run-1", dir, stdout: false, now: fixedNow });
    trace.log({
      agent: "triage",
      action: "classify",
      status: "ok",
      output_summary: "needs full review",
      confidence: 0.8,
    });
    trace.log({ agent: "critic", action: "verify", status: "retry", target_agent: "decision", retry_count: 1 });

    const events = readTrace(trace.file);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0]).toMatchObject({ run_id: "run-1", ts: "2026-10-23T01:02:03.000Z", agent: "triage" });
    expect(events[1]).toMatchObject({ status: "retry", target_agent: "decision", retry_count: 1 });
    expect(trace.file.endsWith("trace-run-1.jsonl")).toBe(true);
  });

  it("records the route taken by a model call", () => {
    const trace = createTraceLogger({ runId: "run-route", dir: tempDir(), stdout: false });
    trace.log({
      agent: "decision",
      action: "generate",
      status: "ok",
      provider: "nightshift",
      model_requested: "meterless/deep",
      model_used: "local-runtime/nemotron-3.5-lightning-30b-a3b",
      route_kind: "local",
      latency_ms: 1200,
    });
    expect(readTrace(trace.file)[0]).toMatchObject({ route_kind: "local", model_requested: "meterless/deep" });
  });

  it("redacts secrets before writing", () => {
    const dir = tempDir();
    const redact = makeRedactor(["super-secret-token-value"]);
    const trace = createTraceLogger({ runId: "run-redact", dir, stdout: false, redact });
    trace.log({
      agent: "evidence",
      action: "query",
      status: "error",
      output_summary: "failed with Bearer super-secret-token-value",
      detail: { authorization: "Bearer abcdefghijklmnop", note: "ok" },
    });
    const raw = readFileSync(trace.file, "utf8");
    expect(raw).not.toContain("super-secret-token-value");
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects events that break the schema", () => {
    const trace = createTraceLogger({ runId: "run-bad", dir: tempDir(), stdout: false });
    expect(() => trace.log({ agent: "wizard" as never, action: "x", status: "ok" })).toThrow();
    expect(() => trace.log({ agent: "triage", action: "x", status: "ok", confidence: 1.5 })).toThrow();
  });

  it("refuses run ids that could escape the log directory", () => {
    for (const bad of ["../escape", "a/b", "a b", ""]) {
      expect(() => createTraceLogger({ runId: bad, dir: tempDir(), stdout: false })).toThrow(AppError);
    }
  });
});

describe("schemas", () => {
  it("accepts a request with an alert id or an inline alert", () => {
    expect(RunRequestSchema.safeParse({ alert_id: "A-0001" }).success).toBe(true);
    expect(RunRequestSchema.safeParse({ alert: { customer: "x" }, options: { sample_mode: true } }).success).toBe(true);
  });

  it("rejects a request with neither, and unsafe run ids", () => {
    expect(RunRequestSchema.safeParse({}).success).toBe(false);
    expect(RunRequestSchema.safeParse({ alert_id: "A-1", run_id: "../x" }).success).toBe(false);
    expect(RunIdSchema.safeParse("ok-run_1.2").success).toBe(true);
    expect(RunIdSchema.safeParse("a..b").success).toBe(false);
  });
});

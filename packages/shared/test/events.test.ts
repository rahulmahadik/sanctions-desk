import { describe, expect, it } from "vitest";
import {
  ALL_RUNS,
  createTraceLogger,
  isTerminalEvent,
  makeRedactor,
  type RunEvent,
  RunEventBus,
  readTrace,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

let counter = 0;
function event(runId: string, over: Partial<RunEvent> = {}): RunEvent {
  return {
    ts: "2026-10-23T00:00:00.000Z",
    run_id: runId,
    seq: counter++,
    agent: "triage",
    action: "classify",
    status: "ok",
    ...over,
  };
}
const done = (runId: string): RunEvent => event(runId, { agent: "system", action: "run_completed" });

const bus = (over: Partial<ConstructorParameters<typeof RunEventBus>[0]> = {}) =>
  new RunEventBus({ replayLimit: 100, maxRuns: 10, ...over });

describe("RunEventBus", () => {
  it("delivers events to subscribers of that run only", () => {
    const b = bus();
    const a: string[] = [];
    const other: string[] = [];
    b.subscribe("run-a", (e) => a.push(e.action));
    b.subscribe("run-b", (e) => other.push(e.action));
    b.publish(event("run-a", { action: "one" }));
    b.publish(event("run-b", { action: "two" }));
    expect(a).toEqual(["one"]);
    expect(other).toEqual(["two"]);
  });

  it("delivers every run's events to a wildcard subscriber", () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe(ALL_RUNS, (e) => seen.push(e.run_id));
    b.publish(event("run-a"));
    b.publish(event("run-b"));
    expect(seen).toEqual(["run-a", "run-b"]);
  });

  it("replays history to a late subscriber, in order, before live events", () => {
    const b = bus();
    b.publish(event("run-a", { action: "first" }));
    b.publish(event("run-a", { action: "second" }));
    const seen: string[] = [];
    b.subscribe("run-a", (e) => seen.push(e.action));
    b.publish(event("run-a", { action: "third" }));
    expect(seen).toEqual(["first", "second", "third"]);
  });

  it("can skip replay, and never replays for the wildcard", () => {
    const b = bus();
    b.publish(event("run-a"));
    const seen: string[] = [];
    b.subscribe("run-a", (e) => seen.push(e.action), { replay: false });
    b.subscribe(ALL_RUNS, (e) => seen.push(`all:${e.action}`));
    expect(seen).toEqual([]);
  });

  it("stops delivering after unsubscribe and cleans up its listener set", () => {
    const b = bus();
    const seen: string[] = [];
    const off = b.subscribe("run-a", (e) => seen.push(e.action));
    expect(b.listenerCount("run-a")).toBe(1);
    b.publish(event("run-a", { action: "before" }));
    off();
    off();
    b.publish(event("run-a", { action: "after" }));
    expect(seen).toEqual(["before"]);
    expect(b.listenerCount("run-a")).toBe(0);
  });

  it("keeps a bad subscriber from affecting the run or other subscribers", () => {
    const errors: unknown[] = [];
    const b = bus({ onListenerError: (e) => errors.push(e) });
    const good: string[] = [];
    b.subscribe("run-a", () => {
      throw new Error("boom");
    });
    b.subscribe("run-a", (e) => good.push(e.action));
    expect(() => b.publish(event("run-a", { action: "x" }))).not.toThrow();
    expect(good).toEqual(["x"]);
    expect(errors).toHaveLength(1);
    expect(b.history("run-a")).toHaveLength(1);
  });

  it("survives an error hook that itself throws, and errors during replay", () => {
    const b = bus({
      onListenerError: () => {
        throw new Error("hook");
      },
    });
    b.publish(event("run-a"));
    expect(() =>
      b.subscribe("run-a", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    expect(() => b.publish(event("run-a"))).not.toThrow();
  });

  it("bounds the replay buffer per run and counts what it dropped", () => {
    const b = bus({ replayLimit: 3 });
    for (let i = 0; i < 5; i++) b.publish(event("run-a", { action: `a${i}` }));
    expect(b.history("run-a").map((e) => e.action)).toEqual(["a2", "a3", "a4"]);
    expect(b.droppedCount("run-a")).toBe(2);
    expect(b.droppedCount("unknown")).toBe(0);
  });

  it("marks a run finished on a terminal system event", () => {
    const b = bus();
    b.publish(event("run-a"));
    expect(b.isFinished("run-a")).toBe(false);
    b.publish(done("run-a"));
    expect(b.isFinished("run-a")).toBe(true);
    expect(b.isFinished("unknown")).toBe(false);
    expect(isTerminalEvent(event("x", { agent: "triage", action: "run_completed" }))).toBe(false);
    expect(isTerminalEvent(event("x", { agent: "system", action: "run_failed" }))).toBe(true);
    expect(isTerminalEvent(event("x", { agent: "system", action: "run_rejected" }))).toBe(true);
  });

  it("evicts finished runs first when over the run limit, never the run being written", () => {
    const b = bus({ maxRuns: 2 });
    b.publish(event("old-active"));
    b.publish(done("old-finished"));
    b.publish(event("new"));
    expect(b.hasRun("old-finished")).toBe(false);
    expect(b.hasRun("old-active")).toBe(true);
    expect(b.hasRun("new")).toBe(true);

    b.publish(event("newer"));
    expect(b.hasRun("old-active")).toBe(false);
    expect(b.hasRun("newer")).toBe(true);
  });

  it("keeps working when the only run over the limit is the one being written", () => {
    const b = bus({ maxRuns: 1 });
    b.publish(event("only"));
    b.publish(event("only"));
    expect(b.history("only")).toHaveLength(2);
  });

  it("returns copies of history so callers cannot change the buffer", () => {
    const b = bus();
    b.publish(event("run-a"));
    (b.history("run-a") as RunEvent[]).length = 0;
    expect(b.history("run-a")).toHaveLength(1);
    expect(b.history("unknown")).toEqual([]);
  });

  it("validates its limits", () => {
    expect(() => new RunEventBus({ replayLimit: 0, maxRuns: 1 })).toThrow(RangeError);
    expect(() => new RunEventBus({ replayLimit: 1, maxRuns: 0 })).toThrow(RangeError);
  });
});

describe("trace logger and event bus", () => {
  it("publishes exactly the events it writes to the file, redacted", () => {
    const dir = tempDir();
    const b = bus();
    const live: RunEvent[] = [];
    b.subscribe("run-live", (e) => live.push(e));
    const trace = createTraceLogger({
      runId: "run-live",
      dir,
      stdout: false,
      bus: b,
      redact: makeRedactor(["leaky-secret-value"]),
    });
    trace.log({ agent: "evidence", action: "query", status: "ok", output_summary: "token leaky-secret-value used" });
    trace.log({ agent: "system", action: "run_completed", status: "ok" });

    expect(live).toEqual(readTrace(trace.file));
    expect(JSON.stringify(live)).not.toContain("leaky-secret-value");
    expect(b.isFinished("run-live")).toBe(true);
  });

  it("stamps the pinned policy version unless an event sets its own", () => {
    const trace = createTraceLogger({ runId: "run-pin", dir: tempDir(), stdout: false, policyVersion: 3 });
    expect(trace.log({ agent: "triage", action: "classify", status: "ok" }).policy_version).toBe(3);
    expect(trace.log({ agent: "triage", action: "x", status: "ok", policy_version: 4 }).policy_version).toBe(4);
  });

  it("does not consume a sequence number or publish when an event is rejected", () => {
    const b = bus();
    const trace = createTraceLogger({ runId: "run-seq", dir: tempDir(), stdout: false, bus: b });
    trace.log({ agent: "triage", action: "ok", status: "ok" });
    expect(() => trace.log({ agent: "triage", action: "bad", status: "ok", confidence: 7 })).toThrow();
    const next = trace.log({ agent: "triage", action: "ok-again", status: "ok" });
    expect(next.seq).toBe(1);
    expect(b.history("run-seq")).toHaveLength(2);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECISION_LABEL, MASK, money, percent, REASON_LENGTH, seconds, shortHash, show } from "../lib/format";
import { graphAt } from "../lib/graph";
import { EVENTS, ev } from "./fixtures";

describe("graphAt", () => {
  it("starts with every step waiting", () => {
    const view = graphAt([]);
    expect(view.steps.every((s) => s.state === "idle")).toBe(true);
    expect(view.finished).toBe(false);
    expect(view.criticRound).toBe(0);
  });

  it("lights the step that is working and keeps earlier ones done", () => {
    const view = graphAt(EVENTS, 4);
    const state = (id: string) => view.steps.find((s) => s.id === id)?.state;
    expect(state("triage")).toBe("done");
    expect(state("evidence")).toBe("done");
    expect(state("matching")).toBe("running");
    expect(state("critic")).toBe("idle");
  });

  it("counts a rejected critic round as a retry of the critic, not a failure", () => {
    const view = graphAt(EVENTS, 6);
    const critic = view.steps.find((s) => s.id === "critic");
    expect(critic?.state).toBe("retry");
    expect(critic?.retries).toBe(1);
    expect(view.criticRound).toBe(1);
  });

  it("counts model retries on the step that retried, and shows which model answered and where", () => {
    const view = graphAt(EVENTS);
    const decision = view.steps.find((s) => s.id === "decision");
    expect(decision?.retries).toBe(1);
    expect(decision?.route).toBe("local");
    expect(decision?.model).toContain("lightning");
    expect(view.criticRound).toBe(2);
    expect(view.finished).toBe(true);
    expect(view.failed).toBe(false);
  });

  it("marks a run that failed or was refused", () => {
    expect(graphAt([ev("system", "run_failed", { status: "error" })]).failed).toBe(true);
    expect(graphAt([ev("system", "run_rejected", { status: "error" })]).finished).toBe(true);
  });

  it("ignores events from steps it does not draw", () => {
    expect(graphAt([ev("human", "approve")]).steps.every((s) => s.events === 0)).toBe(true);
  });

  it("marks an erroring step and a skipped one", () => {
    const view = graphAt([ev("evidence", "x", { status: "error" }), ev("ownership", "x", { status: "skipped" })]);
    expect(view.steps.find((s) => s.id === "evidence")?.state).toBe("error");
    expect(view.steps.find((s) => s.id === "ownership")?.state).toBe("skipped");
  });
});

describe("format", () => {
  it("always draws a masked column as dots, whatever was sent", () => {
    expect(show({ id_number: "******56" }, "id_number", ["id_number"])).toBe(MASK);
    expect(show({ id_number: "******56" }, "id_number")).toBe("******56");
    expect(show({ a: null }, "a")).toBe("—");
    expect(show(null, "a")).toBe("—");
  });

  it("formats numbers and hashes", () => {
    expect(percent(0.9)).toBe("90%");
    expect(seconds(1500)).toBe("1.5 s");
    expect(seconds(undefined)).toBe("—");
    expect(money(0.001, "USD")).toBe("<0.01 USD");
    expect(money(1.5, "USD")).toBe("1.50 USD");
    expect(shortHash("a".repeat(64))).toBe("aaaaaaaa…aaaa");
    expect(shortHash(null)).toBe("—");
    expect(DECISION_LABEL.RECOMMEND_BLOCK).toContain("two approvals");
  });
});

describe("the reason-length rule", () => {
  it("is the human decision step's rule, kept in one web constant", () => {
    const source = readFileSync(join(__dirname, "../../../packages/agents/src/human-decision.ts"), "utf8");
    const min = Number(/export const MIN_REASON_LENGTH = (\d+);/.exec(source)?.[1]);
    const max = Number(/export const MAX_REASON_LENGTH = (\d+);/.exec(source)?.[1]);
    expect(REASON_LENGTH).toEqual({ min, max });
  });

  it("is not written out again in any screen", () => {
    const dir = join(__dirname, "../components");
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/maxLength=\{600\}|MIN_REASON = 10\b|at least 10 characters/);
    }
  });
});

describe("reading the live stream", () => {
  it("takes complete run events and leaves an unfinished block for the next chunk", async () => {
    const { takeEvents } = await import("../lib/api");
    const event = (seq: number, action = "x") =>
      JSON.stringify({ ts: "t", run_id: "r", seq, agent: "evidence", action, status: "ok" });
    const first = takeEvents(
      `event: run_event\ndata: ${event(1)}\n\n: keep-alive\n\nevent: run_event\ndata: ${event(2)}`,
    );
    expect(first.events.map((e) => e.seq)).toEqual([1]);
    const second = takeEvents(`${first.rest}\n\nevent: run_event\ndata: ${event(3)}\n\n`);
    expect(second.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(second.rest).toBe("");
  });

  it("knows the event that ends a run", async () => {
    const { endsRun } = await import("../lib/api");
    const e = (agent: string, action: string) =>
      ({ ts: "t", run_id: "r", seq: 1, agent, action, status: "ok" }) as never;
    expect(endsRun(e("system", "run_completed"))).toBe(true);
    expect(endsRun(e("system", "run_failed"))).toBe(true);
    expect(endsRun(e("system", "run_rejected"))).toBe(true);
    expect(endsRun(e("system", "run_started"))).toBe(false);
    expect(endsRun(e("critic", "run_completed"))).toBe(false);
  });
});

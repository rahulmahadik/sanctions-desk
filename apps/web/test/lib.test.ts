import { describe, expect, it } from "vitest";
import { DECISION_LABEL, MASK, money, percent, seconds, shortHash, show } from "../lib/format";
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

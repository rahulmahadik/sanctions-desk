import { describe, expect, it } from "vitest";
import { closeStop, severityOf, stoppedByOf } from "../src/close-stop.js";

const record = (decision: string, guards: Array<{ guard: string; verdict: string; detail?: string }>) =>
  ({ decision, guards, critic: { rounds: 2, final_verdict: "rejected" } }) as never;
const ev = (seq: number, agent: string, action: string, status: string, output_summary?: string) =>
  ({ seq, agent, action, status, output_summary, ts: "t", run_id: "r" }) as never;

describe("close stop", () => {
  it("is a stop only when the decision first proposed a close and the final outcome is not one", () => {
    const events = [
      ev(0, "triage", "start", "ok"),
      ev(1, "decision", "recommend", "ok", "CLOSE_FALSE_POSITIVE: names differ"),
    ];
    const stop = closeStop(
      record("ESCALATE_L2", [
        { guard: "jurisdiction", verdict: "block", detail: "watched jurisdiction: IR" },
        { guard: "screener", verdict: "block", detail: "risk signal" },
        { guard: "data_quality", verdict: "pass" },
      ]),
      events,
    );
    expect(stop).toEqual({
      stopped: true,
      by: ["policy guard", "screener"],
      reasons: ["jurisdiction: watched jurisdiction: IR", "screener: risk signal"],
    });
    expect(closeStop(record("CLOSE_FALSE_POSITIVE", []), events).stopped).toBe(false);
    const escalatedFirst = [ev(0, "decision", "recommend", "ok", "ESCALATE_L2: listed")];
    expect(
      closeStop(record("ESCALATE_L2", [{ guard: "jurisdiction", verdict: "block" }]), escalatedFirst).stopped,
    ).toBe(false);
  });

  it("names the critic when it sent the close back and no guard had to block", () => {
    const events = [
      ev(0, "decision", "recommend", "ok", "CLOSE_FALSE_POSITIVE: x"),
      ev(1, "critic", "judge", "blocked", "rejected"),
      ev(2, "decision", "recommend", "ok", "NEED_MORE_INFO: y"),
    ];
    expect(closeStop(record("NEED_MORE_INFO", []), events)).toMatchObject({ stopped: true, by: ["critic"] });
  });

  it("reads only the newest run in a trace file that holds several", () => {
    const events = [
      ev(0, "decision", "recommend", "ok", "CLOSE_FALSE_POSITIVE: old"),
      ev(0, "decision", "recommend", "ok", "ESCALATE_L2: new"),
    ];
    expect(closeStop(record("ESCALATE_L2", [{ guard: "jurisdiction", verdict: "block" }]), events).stopped).toBe(false);
  });

  it("maps guards to the four kinds of check, and grades severity from the match score", () => {
    expect(["screener_grounding", "missing_data", "critic_unresolved", "evidence_standard"].map(stoppedByOf)).toEqual([
      "screener",
      "data quality",
      "critic",
      "policy guard",
    ]);
    expect([1, 0.95, 0.9, 0.85, 0.84].map((s) => severityOf(s, 0.85))).toEqual([
      "high",
      "high",
      "medium",
      "medium",
      "low",
    ]);
  });
});

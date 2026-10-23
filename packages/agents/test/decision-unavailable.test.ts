import { readFileSync } from "node:fs";
import { AppError } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  DECISION_UNAVAILABLE,
  FactSchema,
  normaliseDecision,
  runReview,
  summarise,
  unavailableCause,
} from "../src/index.js";
import { caseFacts, sampleDeps, scriptedGenerator } from "./helpers.js";

const fp = caseFacts("fp_dob_exact_name_0");
const safe = JSON.stringify({ violation: false, category: "none", reasons: [] });
const request = { runId: "unavailable-test", alertId: fp.alertId, sampleMode: true };

describe("a fact written with the wrong kind of value", () => {
  it("cites the text of a number or a true/false, and still refuses an object", () => {
    const ok = FactSchema.parse({ table: "t", key_value: 7, column: "c", value: true });
    expect(ok).toMatchObject({ key_value: "7", value: "true" });
    expect(FactSchema.parse({ table: "t", key_value: "k", column: "c", value: null }).value).toBeNull();
    expect(FactSchema.safeParse({ table: "t", key_value: "k", column: "c", value: { a: 1 } }).success).toBe(false);
  });
});

describe("decision spellings", () => {
  it.each([
    ["escalate", "ESCALATE_L2"],
    ["Escalate to L2", "ESCALATE_TO_L2"],
    ["close-false-positive", "CLOSE_FALSE_POSITIVE"],
    ["BLOCK", "RECOMMEND_BLOCK"],
    ["needs more info", "NEEDS_MORE_INFO"],
    ["ESCALATE_L2", "ESCALATE_L2"],
  ])("reads %s as the same decision", (written, mapped) => {
    expect(normaliseDecision(written)).toBe(
      mapped === "ESCALATE_TO_L2" ? "ESCALATE_L2" : mapped === "NEEDS_MORE_INFO" ? "NEED_MORE_INFO" : mapped,
    );
  });

  it("leaves anything it does not know alone, so the schema rejects it", () => {
    expect(normaliseDecision("approve")).toBe("APPROVE");
    expect(normaliseDecision(7)).toBe(7);
  });
});

describe("a decision step that never gets a usable answer", () => {
  it("escalates to a person with the reason, never closes, and skips the critic", async () => {
    const { generator, requests } = scriptedGenerator([safe, "no json at all"]);
    const deps = sampleDeps({ generator });
    const res = await runReview(deps, request);
    expect(res.status).toBe("ok");
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.decision).not.toBe("CLOSE_FALSE_POSITIVE");
    expect(res.confidence).toBeLessThanOrEqual(0.3);
    expect(res.rationale).toContain(DECISION_UNAVAILABLE);
    expect(res.guards?.find((g) => g.guard === "model_decision")).toMatchObject({
      verdict: "block",
      detail: expect.stringContaining("the answer was unusable"),
    });
    expect(res.critic).toMatchObject({ final_verdict: "not_run" });
    // The safety guard, then three tries at the decision (own model, fast lane, backup provider); no critic call.
    expect(requests).toHaveLength(4);
    // The backup is the local model: it gets a plain JSON request, not schema-constrained output.
    expect(requests.at(-1)).toMatchObject({ provider: "ollama", prefill: "{" });
    expect(requests.at(-1)?.jsonSchema).toBeUndefined();
  });

  it("keeps the failed answer's ending and length in the trace to explain it", async () => {
    const { generator } = scriptedGenerator([safe, `${"x".repeat(300)} and then it stopped`]);
    const deps = sampleDeps({ generator });
    await runReview(deps, { ...request, runId: "unavailable-trace" });
    const lines = readFileSync(`${deps.logDir}/trace-agents-test.jsonl`, "utf8").split("\n").filter(Boolean);
    const failed = lines
      .map((l) => JSON.parse(l) as { agent: string; action: string; status: string; detail?: Record<string, unknown> })
      .filter((e) => e.agent === "decision" && e.action === "model_answer" && e.status !== "ok");
    expect(failed.length).toBe(3);
    expect(failed[0]?.detail).toMatchObject({ answer_chars: 320, finish_reason: null });
    expect(String(failed[0]?.detail?.answer_tail)).toContain("and then it stopped");
  });
});

describe("telling a provider failure from an unusable answer", () => {
  it("calls an unreachable model service a provider failure", async () => {
    const down = new AppError("http_error", "all model providers failed", { recoverable: true });
    const { generator } = scriptedGenerator([safe, down]);
    const res = await runReview(sampleDeps({ generator }), { ...request, runId: "provider-failure" });
    expect(res.guards?.find((g) => g.guard === "model_decision")?.detail).toContain("the model service failed");
  });

  it.each([
    [new AppError("http_error", "ollama returned HTTP 500"), "provider"],
    [new AppError("bad_response", "nightshift returned an empty answer (cut off by the token limit)"), "provider"],
    [new AppError("network", "network error: refused"), "provider"],
    [new AppError("bad_response", "the model answer has no JSON object"), "parsing"],
    [new AppError("bad_response", "decision: Invalid option"), "parsing"],
  ])("classifies %s", (err, cause) => {
    expect(unavailableCause(err)).toBe(cause);
  });
});

describe("exam metrics for unavailable decisions", () => {
  const base = { group: "g", kind: "k", acceptable: [], must_not: ["CLOSE_FALSE_POSITIVE"] };
  const cases = [
    { ...base, case_id: "1", expected: "ESCALATE_L2", got: "ESCALATE_L2" },
    {
      ...base,
      case_id: "2",
      expected: "NEED_MORE_INFO",
      got: "ESCALATE_L2",
      decision_unavailable: "provider" as const,
    },
    { ...base, case_id: "3", expected: "ESCALATE_L2", got: "ESCALATE_L2", decision_unavailable: "parsing" as const },
  ];

  it("counts them in the totals and also reports accuracy without them", () => {
    const m = summarise(cases);
    expect(m.decision_unavailable).toBe(2);
    expect(m.decision_unavailable_by_cause).toEqual({ provider: 1, parsing: 1, withheld: 0 });
    expect(m.exact_accuracy).toBeCloseTo(0.6667, 3);
    expect(m.excluding_unavailable).toEqual({ cases: 1, exact_accuracy: 1, acceptable_accuracy: 1 });
    expect(m.false_closes).toBe(0);
  });
});

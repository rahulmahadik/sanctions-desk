import { describe, expect, it } from "vitest";
import { runReview } from "../src/index.js";
import { caseFacts, sampleDeps, scriptedGenerator } from "./helpers.js";

const fp = caseFacts("fp_dob_exact_name_0");
const goodFacts = [
  { table: "customer", key_value: fp.customerId, column: "full_name", value: fp.customerName },
  { table: "list_entry", key_value: fp.entryId, column: "primary_name", value: fp.entryName },
];
const decision = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    decision: "CLOSE_FALSE_POSITIVE",
    confidence: 0.9,
    rationale: "The dates of birth conflict and the nationality differs.",
    facts: goodFacts,
    what_would_change: ["A matching document number"],
    ...over,
  });
const approve = JSON.stringify({ verdict: "approve", issues: [] });
const reject = (issue: string) => JSON.stringify({ verdict: "reject", issues: [issue] });

/** The model script for several rounds: a decision answer, then a critic answer, repeated. */
const rounds = (d: string, c: string, n: number) => Array.from({ length: n }, () => [d, c]).flat();

const tm = caseFacts("tm_exact_0");
const request = { runId: "pipeline-test", alertId: fp.alertId, sampleMode: true };

describe("runReview with a scripted model", () => {
  it("approves when the cited facts hold and the critic agrees", async () => {
    const { generator } = scriptedGenerator([decision(), approve]);
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res).toMatchObject({ decision: "CLOSE_FALSE_POSITIVE", critic: { rounds: 1, final_verdict: "approved" } });
    expect(res.models).toHaveLength(2);
  });

  it("sends the recommendation back with neutral notes when the critic objects, then accepts the correction", async () => {
    const { generator, requests } = scriptedGenerator([
      decision(),
      reject("rationale mentions a country that is not in the evidence"),
      decision(),
      approve,
    ]);
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res.critic).toEqual({ rounds: 2, final_verdict: "approved" });
    const second = requests[2]?.prompt ?? "";
    expect(second).toContain("Notes from the checking step");
    expect(second).toContain("rationale mentions a country");
    expect(second.toLowerCase()).not.toContain("rejected");
  });

  it("re-reads every cited fact: a claim that does not match the data is never approved", async () => {
    const wrong = [{ ...goodFacts[0], value: "Someone Else" }, goodFacts[1]];
    const { generator } = scriptedGenerator(rounds(decision({ facts: wrong }), approve, 3));
    const res = await runReview(sampleDeps({ generator }), request);
    // The model agreed with itself in every round, but the check against the data failed each time.
    expect(res.critic).toEqual({ rounds: 3, final_verdict: "escalated" });
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.guards.some((g) => g.guard === "critic_unresolved" && g.verdict === "block")).toBe(true);
    expect(res.rationale).toContain("could not approve");
  });

  it("flags a fact about a table or row that does not exist", async () => {
    const bad = [
      { table: "nonexistent", key_value: "1", column: "x", value: "y" },
      { ...goodFacts[0], key_value: "CUST-9999" },
    ];
    const { generator } = scriptedGenerator(rounds(decision({ facts: bad }), approve, 3));
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res.critic?.final_verdict).toBe("escalated");
  });

  it("catches a close recommended on a strong match even if the model approves it", async () => {
    const fact = {
      table: "customer",
      key_value: "CUST-001",
      column: "full_name",
      value: "Bassem Murad",
    };
    const { generator } = scriptedGenerator(rounds(decision({ facts: [fact] }), approve, 3));
    const res = await runReview(sampleDeps({ generator }), { ...request, alertId: tm.alertId });
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.critic?.final_verdict).toBe("escalated");
  });

  it("fails with a structured error when the model never returns a valid answer", async () => {
    const { generator } = scriptedGenerator(["I cannot help with that."]);
    await expect(runReview(sampleDeps({ generator }), request)).rejects.toMatchObject({ type: "bad_response" });
  });

  it("passes a model failure through as a structured error", async () => {
    const { generator } = scriptedGenerator([
      Object.assign(new Error("all model providers failed"), { type: "http_error" }),
    ]);
    await expect(runReview(sampleDeps({ generator }), request)).rejects.toThrow(/all model providers failed/);
  });

  it("stops at the number of critic rounds the policy allows", async () => {
    const base = sampleDeps();
    const policy = { ...base.policy, critic: { ...base.policy.critic, maxRounds: 1 } };
    const { generator } = scriptedGenerator([decision(), reject("not convinced")]);
    const res = await runReview(sampleDeps({ generator, policy }), request);
    expect(res.critic).toEqual({ rounds: 1, final_verdict: "escalated" });
  });

  it("answers an unknown alert with a not-found error", async () => {
    const { generator } = scriptedGenerator([decision()]);
    await expect(runReview(sampleDeps({ generator }), { ...request, alertId: "ALR-9999" })).rejects.toMatchObject({
      type: "query_failed",
    });
  });
});

describe("a critic that cannot answer", () => {
  it("approves nothing: the recommendation goes to a person", async () => {
    // The critic is asked twice per round (its second try is the retry), so it gets two unusable answers each time.
    const { generator } = scriptedGenerator(Array.from({ length: 3 }, () => [decision(), "no", "no"]).flat());
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res.critic?.final_verdict).toBe("escalated");
    expect(res.decision).toBe("ESCALATE_L2");
  });

  it("accepts the verdict however the model spells it", async () => {
    const { generator } = scriptedGenerator([decision(), JSON.stringify({ verdict: "Approved", issues: [] })]);
    expect((await runReview(sampleDeps({ generator }), request)).critic?.final_verdict).toBe("approved");
  });
});

import { AppError } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { runReview } from "../src/index.js";
import { caseFacts, sampleDeps, scriptedGenerator } from "./helpers.js";

/** The first model call of every review is the safety guard reading the free text of the data. */
const safe = JSON.stringify({ violation: false, category: "none", reasons: [] });
const scripted = (answers: Array<string | Error>) => scriptedGenerator([safe, ...answers]);

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
    const { generator } = scripted([decision(), approve]);
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res).toMatchObject({ decision: "CLOSE_FALSE_POSITIVE", critic: { rounds: 1, final_verdict: "approved" } });
    expect(res.models.map((m) => m.agent)).toEqual(["policy_guard", "decision", "critic"]);
  });

  it("sends the recommendation back with neutral notes when the critic objects, then accepts the correction", async () => {
    const { generator, requests } = scripted([
      decision(),
      reject("rationale mentions a country that is not in the evidence"),
      decision(),
      approve,
    ]);
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res.critic).toEqual({ rounds: 2, final_verdict: "approved" });
    const second = requests[3]?.prompt ?? "";
    expect(second).toContain("Notes from the checking step");
    expect(second).toContain("rationale mentions a country");
    expect(second.toLowerCase()).not.toContain("rejected");
  });

  it("re-reads every cited fact: a claim that does not match the data is never approved", async () => {
    const wrong = [{ ...goodFacts[0], value: "Someone Else" }, goodFacts[1]];
    const { generator } = scripted(rounds(decision({ facts: wrong }), approve, 3));
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
    const { generator } = scripted(rounds(decision({ facts: bad }), approve, 3));
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
    const { generator } = scripted(rounds(decision({ facts: [fact] }), approve, 3));
    const res = await runReview(sampleDeps({ generator }), { ...request, alertId: tm.alertId });
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.critic?.final_verdict).toBe("escalated");
  });

  it("escalates to a person when the model never returns a valid answer", async () => {
    const { generator } = scripted(["I cannot help with that."]);
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res).toMatchObject({ decision: "ESCALATE_L2", critic: { final_verdict: "not_run" } });
    expect(res.guards?.some((g) => g.guard === "model_decision")).toBe(true);
  });

  it("escalates, and never closes, when every model provider is down", async () => {
    const down = new AppError("http_error", "all model providers failed", { recoverable: true });
    const { generator } = scripted([down]);
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.rationale).toContain("model decision unavailable");
  });

  it("still stops on a fault in the desk's own setup", async () => {
    const broken = new AppError("config_missing", "no model is configured", { recoverable: false });
    const { generator } = scripted([broken]);
    await expect(runReview(sampleDeps({ generator }), request)).rejects.toThrow(/no model is configured/);
  });

  it("stops at the number of critic rounds the policy allows", async () => {
    const base = sampleDeps();
    const policy = { ...base.policy, critic: { ...base.policy.critic, maxRounds: 1 } };
    const { generator } = scripted([decision(), reject("not convinced")]);
    const res = await runReview(sampleDeps({ generator, policy }), request);
    expect(res.critic).toEqual({ rounds: 1, final_verdict: "escalated" });
  });

  it("answers an unknown alert with a not-found error", async () => {
    const { generator } = scripted([decision()]);
    await expect(runReview(sampleDeps({ generator }), { ...request, alertId: "ALR-9999" })).rejects.toMatchObject({
      type: "query_failed",
    });
  });
});

describe("a critic that cannot answer", () => {
  it("approves nothing: the recommendation goes to a person", async () => {
    // The critic is asked three times per round (own model, fast retry, backup), so it gets three unusable answers each time.
    const { generator } = scripted(Array.from({ length: 3 }, () => [decision(), "no", "no", "no"]).flat());
    const res = await runReview(sampleDeps({ generator }), request);
    expect(res.critic?.final_verdict).toBe("escalated");
    expect(res.decision).toBe("ESCALATE_L2");
  });

  it("accepts the verdict however the model spells it", async () => {
    const { generator } = scripted([decision(), JSON.stringify({ verdict: "Approved", issues: [] })]);
    expect((await runReview(sampleDeps({ generator }), request)).critic?.final_verdict).toBe("approved");
  });
});

describe("memory of earlier decisions", () => {
  const goodDecision = (c: ReturnType<typeof caseFacts>) =>
    decision({
      facts: [
        { table: "customer", key_value: c.customerId, column: "full_name", value: c.customerName },
        { table: "list_entry", key_value: c.entryId, column: "primary_name", value: c.entryName },
      ],
    });

  it("takes the fast path when an earlier clearance still holds: no reasoning, and the record says why", async () => {
    const c = caseFacts("pcu_0");
    const { generator, requests } = scripted([goodDecision(c), approve]);
    const res = await runReview(sampleDeps({ generator }), {
      runId: "mem-fresh",
      alertId: c.alertId,
      sampleMode: true,
    });
    expect(res.decision).toBe("CLOSE_FALSE_POSITIVE");
    expect(requests[1]?.prefill).toBe("{");
    expect(requests[1]?.system).not.toContain("Keep any reasoning");
    expect(requests[1]?.prompt).toContain("fresh: the listed entry has not changed since");
  });

  it("does not take the fast path for a case with no earlier decision", async () => {
    const c = caseFacts("fp_dob_exact_name_0");
    const { generator, requests } = scripted([goodDecision(c), approve]);
    await runReview(sampleDeps({ generator }), { runId: "mem-none", alertId: c.alertId, sampleMode: true });
    expect(requests[1]?.system).toContain("Keep any reasoning");
    expect(requests[1]?.prompt).toContain('"earlier_decisions":[]');
  });

  it("marks an earlier clearance stale when the listed entry changed since", async () => {
    const c = caseFacts("pcc_dob_0");
    const { generator, requests } = scripted(rounds(goodDecision(c), approve, 3));
    const res = await runReview(sampleDeps({ generator }), {
      runId: "mem-stale",
      alertId: c.alertId,
      sampleMode: true,
    });
    expect(requests[1]?.prompt).toContain("stale: the listed entry changed since");
    expect(requests[1]?.system).toContain("Keep any reasoning");
    // The approved definition of a true match is now met, so a person must see it whatever the model said.
    expect(res.decision).toBe("ESCALATE_L2");
  });
});

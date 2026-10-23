import { loadPolicyFile } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { readDecisionRecords, runReview } from "../src/index.js";
import { caseFacts, quietPolicy, sampleDeps, scriptedGenerator } from "./helpers.js";

/** A whole review at autonomy level 1, with a model script that closes a settled false positive. */
const fp = caseFacts("fp_dob_exact_name_0");
const safe = JSON.stringify({ violation: false, category: "none", reasons: [] });
const approve = JSON.stringify({ verdict: "approve", issues: [] });
const closeAnswer = (confidence = 0.95) =>
  JSON.stringify({
    decision: "CLOSE_FALSE_POSITIVE",
    confidence,
    rationale: "The dates of birth conflict and the nationality differs.",
    facts: [
      { table: "customer", key_value: fp.customerId, column: "full_name", value: fp.customerName },
      { table: "list_entry", key_value: fp.entryId, column: "primary_name", value: fp.entryName },
    ],
    what_would_change: [],
  });

const policyAt = (level: 0 | 1, over: { rate?: number; cap?: number } = {}) => {
  const p = quietPolicy();
  return {
    ...p,
    autonomy: {
      ...p.autonomy,
      level,
      autoClose: { ...p.autonomy.autoClose, qaSampleRate: over.rate ?? 0.1, dailyCap: over.cap ?? 50 },
    },
  };
};

async function review(
  level: 0 | 1,
  over: { draw?: number; kill?: boolean; closedToday?: number; cap?: number; confidence?: number; runId?: string } = {},
) {
  const { generator } = scriptedGenerator([safe, closeAnswer(over.confidence), approve]);
  const deps = {
    ...sampleDeps({ generator, policy: policyAt(level, { cap: over.cap }) }),
    random: () => over.draw ?? 0.99,
    killSwitch: () => over.kill === true,
    autoClosedToday: () => over.closedToday ?? 0,
  };
  const res = await runReview(deps, { runId: over.runId ?? "auto-1", alertId: fp.alertId, sampleMode: true });
  return { res, deps };
}

describe("a review at level 0", () => {
  it("leaves the decision to a person and records nothing about autonomy", async () => {
    const { res, deps } = await review(0);
    expect(res.decision).toBe("CLOSE_FALSE_POSITIVE");
    expect(res.autonomy).toBeUndefined();
    expect(res.human_review_required).toBe(true);
    expect(readDecisionRecords(deps.logDir)[0]?.autonomy).toBeUndefined();
  });
});

describe("a review at level 1", () => {
  it("closes automatically, says so in the response and in the sealed record, and no longer waits for a person", async () => {
    const { res, deps } = await review(1);
    expect(res.autonomy?.outcome).toBe("auto_closed");
    expect(res.autonomy?.statement).toMatch(/^closed automatically under policy v\d+, level 1, conditions met: /);
    expect(res.human_review_required).toBe(false);
    const record = readDecisionRecords(deps.logDir)[0];
    expect(record?.autonomy?.outcome).toBe("auto_closed");
    expect(record?.autonomy?.qa_draw).toBe(0.99);
  });

  it("sends a quality-assurance sample to a person while still recording that it qualified", async () => {
    const { res } = await review(1, { draw: 0.05 });
    expect(res.autonomy?.outcome).toBe("qa_sample");
    expect(res.autonomy?.statement).toBeUndefined();
    expect(res.human_review_required).toBe(true);
  });

  it("goes to a person when the kill switch is on, and says the level in force is 0", async () => {
    const { res } = await review(1, { kill: true });
    expect(res.autonomy).toMatchObject({ policy_level: 1, level_in_force: 0, outcome: "human_review" });
    expect(res.human_review_required).toBe(true);
  });

  it("goes to a person once the daily cap is reached", async () => {
    const { res } = await review(1, { closedToday: 5, cap: 5 });
    expect(res.autonomy?.outcome).toBe("human_review");
    expect(res.autonomy?.conditions.find((c) => c.name === "daily_cap")?.met).toBe(false);
  });

  it("goes to a person when the confidence is below the policy line", async () => {
    const { res } = await review(1, { confidence: 0.85 });
    expect(res.autonomy?.outcome).toBe("human_review");
  });

  it("never closes automatically a case that is escalated, whatever the setting", async () => {
    const tm = caseFacts("tm_exact_0");
    const escalate = JSON.stringify({
      decision: "ESCALATE_L2",
      confidence: 0.99,
      rationale: "A true match.",
      facts: [{ table: "customer", key_value: tm.customerId, column: "full_name", value: tm.customerName }],
      what_would_change: [],
    });
    const { generator } = scriptedGenerator([safe, escalate, approve]);
    const deps = { ...sampleDeps({ generator, policy: policyAt(1) }), random: () => 0.99 };
    const res = await runReview(deps, { runId: "auto-esc", alertId: tm.alertId, sampleMode: true });
    expect(res.decision).not.toBe("CLOSE_FALSE_POSITIVE");
    expect(res.autonomy?.outcome).toBe("human_review");
  });

  it("is the shipped default of level 0 until a policy is published", () => {
    expect(loadPolicyFile("config/policy.default.json").autonomy.level).toBe(0);
  });
});

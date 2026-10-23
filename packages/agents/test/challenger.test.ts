import { describe, expect, it } from "vitest";
import {
  CHALLENGE_JSON_SCHEMA,
  CHALLENGER_SYSTEM,
  ChallengeSchema,
  challengeTriggers,
  type DecisionOutput,
  type EvidenceBundle,
  type MatchResult,
  runReview,
} from "../src/index.js";
import { caseFacts, quietPolicy, sampleDeps, scriptedGenerator } from "./helpers.js";

const policy = (over: Partial<ReturnType<typeof quietPolicy>["challenger"]> = {}) => {
  const base = quietPolicy();
  return { ...base, challenger: { ...base.challenger, enabled: true, ...over } };
};
const close = (confidence: number): DecisionOutput => ({
  decision: "CLOSE_FALSE_POSITIVE",
  confidence,
  rationale: "r",
  facts: [],
  what_would_change: [],
});
const matchWith = (score: number) => ({ comparison: { name: { score } } }) as unknown as MatchResult;
const evidenceWith = (dq: Array<{ failed: boolean }>) => ({ dq }) as unknown as EvidenceBundle;

describe("when the challenger looks at a close", () => {
  it("fires for a low-confidence close, a very close name, or a failing data-quality rule", () => {
    const quiet = { confidenceBelow: 0.5, nameScoreAtLeast: 1, onDataQualityIssue: false };
    expect(challengeTriggers(policy(quiet), close(0.9), matchWith(0.5), evidenceWith([]))).toEqual([]);
    expect(
      challengeTriggers(policy({ ...quiet, confidenceBelow: 0.95 }), close(0.9), matchWith(0.5), evidenceWith([]))[0],
    ).toContain("confidence 0.9 is below 0.95");
    expect(
      challengeTriggers(policy({ ...quiet, nameScoreAtLeast: 0.9 }), close(0.99), matchWith(0.97), evidenceWith([]))[0],
    ).toContain("name similarity 0.97");
    expect(
      challengeTriggers(
        policy({ ...quiet, onDataQualityIssue: true }),
        close(0.99),
        matchWith(0.5),
        evidenceWith([{ failed: true }]),
      ),
    ).toEqual(["a data-quality rule fails"]);
    expect(
      challengeTriggers(
        policy({ ...quiet, onDataQualityIssue: true }),
        close(0.99),
        matchWith(0.5),
        evidenceWith([{ failed: false }]),
      ),
    ).toEqual([]);
  });

  it("stays silent unless the decision is a close, and when the policy turns it off", () => {
    const loud = { confidenceBelow: 1, nameScoreAtLeast: 0, onDataQualityIssue: true };
    const escalate = { ...close(0.1), decision: "ESCALATE_L2" as const };
    expect(challengeTriggers(policy(loud), escalate, matchWith(1), evidenceWith([]))).toEqual([]);
    expect(challengeTriggers(policy({ ...loud, enabled: false }), close(0.1), matchWith(1), evidenceWith([]))).toEqual(
      [],
    );
    expect(challengeTriggers(policy(loud), close(0.1), matchWith(1), evidenceWith([])).length).toBeGreaterThan(0);
  });
});

const fp = caseFacts("fp_dob_exact_name_0");
const safe = JSON.stringify({ violation: false, category: "none", reasons: [] });
const closeAnswer = JSON.stringify({
  decision: "CLOSE_FALSE_POSITIVE",
  confidence: 0.9,
  rationale: "The dates of birth conflict and the nationality differs.",
  facts: [
    { table: "customer", key_value: fp.customerId, column: "full_name", value: fp.customerName },
    { table: "list_entry", key_value: fp.entryId, column: "primary_name", value: fp.entryName },
  ],
  what_would_change: ["A matching document number"],
});
const approve = JSON.stringify({ verdict: "approve", issues: [] });
const credible = JSON.stringify({
  credible: true,
  argument: "The listed birth year is only approximate.",
  points: ["dob is a year"],
});
const notCredible = JSON.stringify({ credible: false, argument: "Every identifying field conflicts.", points: [] });
const request = { runId: "challenger-test", alertId: fp.alertId, sampleMode: true };

describe("the challenger's answer", () => {
  it("accepts up to eight points in the order given, and cuts a longer list at eight instead of failing", () => {
    const six = ChallengeSchema.parse({ credible: false, argument: "a", points: ["1", "2", "3", "4", "5", "6"] });
    expect(six.points).toEqual(["1", "2", "3", "4", "5", "6"]);
    const ten = ChallengeSchema.parse({
      credible: false,
      argument: "a",
      points: Array.from({ length: 10 }, (_, i) => `p${i}`),
    });
    expect(ten.points).toHaveLength(8);
    expect(ten.points[0]).toBe("p0");
  });

  it("asks for the strongest point first and allows eight points in the schema", () => {
    expect(CHALLENGER_SYSTEM).toContain("strongest first");
    expect(CHALLENGE_JSON_SCHEMA.schema.properties.points.maxItems).toBe(8);
  });
});

describe("a close that is challenged", () => {
  it("becomes an escalation, with the challenger's argument shown, when the argument is credible", async () => {
    const { generator, requests } = scriptedGenerator([safe, closeAnswer, approve, credible]);
    const res = await runReview(sampleDeps({ generator, policy: policy() }), request);
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.confidence).toBeLessThanOrEqual(0.6);
    expect(res.rationale).toContain("Challenger: a credible true-match argument was found");
    expect(res.rationale).toContain("birth year is only approximate");
    expect(res.guards?.find((g) => g.guard === "challenger")).toMatchObject({ verdict: "block" });
    expect(res.agents).toContain("challenger");
    expect(res.models.map((m) => m.agent)).toContain("challenger");
    expect(requests.at(-1)?.lane).toBe("deep");
    expect(requests.at(-1)?.jsonSchema?.name).toBe("challenge");
  });

  it("leaves the close standing, and says it ran, when there is no credible argument", async () => {
    const { generator } = scriptedGenerator([safe, closeAnswer, approve, notCredible]);
    const res = await runReview(sampleDeps({ generator, policy: policy() }), { ...request, runId: "challenger-none" });
    expect(res.decision).toBe("CLOSE_FALSE_POSITIVE");
    expect(res.guards?.find((g) => g.guard === "challenger")).toMatchObject({ verdict: "pass" });
  });

  it("does not let a close stand when the challenger cannot answer", async () => {
    const { generator } = scriptedGenerator([safe, closeAnswer, approve, "no json at all"]);
    const res = await runReview(sampleDeps({ generator, policy: policy() }), { ...request, runId: "challenger-down" });
    expect(res.decision).toBe("ESCALATE_L2");
    expect(res.rationale).toContain("could not be challenged");
    expect(res.guards?.find((g) => g.guard === "challenger")?.detail).toContain("could not answer");
  });

  it("does not run when the policy turns it off or the comparison switches it off", async () => {
    const off = scriptedGenerator([safe, closeAnswer, approve]);
    const a = await runReview(sampleDeps({ generator: off.generator, policy: quietPolicy() }), {
      ...request,
      runId: "c-off",
    });
    expect(a.decision).toBe("CLOSE_FALSE_POSITIVE");
    expect(a.guards?.some((g) => g.guard === "challenger")).toBe(false);
    const single = scriptedGenerator([safe, closeAnswer]);
    const b = await runReview(sampleDeps({ generator: single.generator, policy: policy() }), {
      ...request,
      runId: "c-single",
      options: { critic: false, challenger: false },
    });
    expect(b.guards?.some((g) => g.guard === "challenger")).toBe(false);
  });
});

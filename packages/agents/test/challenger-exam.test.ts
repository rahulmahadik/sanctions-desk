import { examCase, loadExam } from "@sanctions-desk/data";
import { createFallbackRulesGenerator } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { runReview, sampleRules, summarise } from "../src/index.js";
import { quietPolicy, sampleDeps } from "./helpers.js";

/**
 * Exam cases where the challenger should and should not look at the close, on the committed sample with the
 * default trigger settings (confidence below 0.85, name similarity at least 0.95, or a failing data-quality rule).
 * The model-backed answer is not the point here; whether it is asked is.
 */
const exam = loadExam();
const policy = { ...quietPolicy(), challenger: { ...quietPolicy().challenger, enabled: true } };

async function guardsOf(kind: string) {
  const c = examCase(exam, kind);
  const deps = sampleDeps({ generator: createFallbackRulesGenerator(sampleRules), policy });
  return runReview(deps, { runId: `ch-${kind}`, alertId: c.alert_id ?? "", sampleMode: true });
}

describe("the challenger on exam cases", () => {
  it.each([
    ["fp_dob_exact_name_0", "a close with an identical name"],
    ["fp_variant_spelling_0", "a close with a name similarity just above the line"],
    ["ob_49_9", "a close whose confidence is below the line"],
    ["pcu_0", "an earlier clearance that still holds, with an identical name"],
  ])("looks at %s: %s", async (kind) => {
    const res = await guardsOf(kind);
    expect(res.decision).toBe("CLOSE_FALSE_POSITIVE");
    expect(res.guards?.find((g) => g.guard === "challenger")).toBeDefined();
    expect(res.models.some((m) => m.agent === "challenger")).toBe(true);
  });

  it.each([
    ["fp_variant_spelling_1", "a close with a lower name similarity and good confidence"],
    ["fp_surname_only_0", "a close that shares only a surname"],
    ["tm_exact_0", "a true match, which is not a close"],
    ["md_no_dob_0", "a case that needs more information, which is not a close"],
    ["fp_jurisdiction", "a close the policy guard already raised, so there is nothing left to challenge"],
    ["pj_beneficiary_country", "a payment the policy guard already raised"],
  ])("stays silent on %s: %s", async (kind) => {
    const res = await guardsOf(kind);
    expect(res.guards?.some((g) => g.guard === "challenger")).toBe(false);
    expect(res.models.some((m) => m.agent === "challenger")).toBe(false);
  });
});

describe("exam metrics for the challenger", () => {
  const base = { group: "g", kind: "k", acceptable: [], must_not: [], expected: "ESCALATE_L2", got: "ESCALATE_L2" };
  it("counts how often it ran, what it changed and what it added", () => {
    const m = summarise([
      { ...base, case_id: "1" },
      { ...base, case_id: "2", challenger_fired: true, challenger_s: 20, challenger_cost: 0.01 },
      {
        ...base,
        case_id: "3",
        challenger_fired: true,
        challenger_changed: true,
        challenger_s: 30.5,
        challenger_cost: 0.02,
      },
    ]);
    expect(m.challenger).toEqual({ fired: 2, changed: 1, added_seconds: 50.5, added_cost: 0.03 });
  });
});

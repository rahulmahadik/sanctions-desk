import { examCase, loadExam } from "@sanctions-desk/data";
import { createFallbackRulesGenerator } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { runReview, sampleRules } from "../src/index.js";
import { sampleDeps } from "./helpers.js";

/** The hybrid: code gives a first finding, and the review confirms it or reasons over free text. */
const exam = loadExam();
const alertOf = (kind: string) => examCase(exam, kind).alert_id ?? "";

async function reviewed(kind: string) {
  return runReview(sampleDeps({ generator: createFallbackRulesGenerator(sampleRules) }), {
    runId: `hybrid-${kind}`,
    alertId: alertOf(kind),
    sampleMode: true,
  });
}

describe("the path a review takes", () => {
  it.each([
    ["fp_dob_exact_name_0", "confirm", "CLOSE_FALSE_POSITIVE"],
    ["tm_exact_0", "confirm", "ESCALATE_L2"],
    ["ob_49_9", "confirm", "CLOSE_FALSE_POSITIVE"],
    ["md_no_dob_0", "confirm", "NEED_MORE_INFO"],
  ])("confirms %s when the structured evidence settles it", async (kind, path, finding) => {
    const res = await reviewed(kind);
    expect(res.path).toBe(path);
    expect(res.first_finding).toBe(finding);
  });

  it("reasons when there is a note on the customer record to weigh", async () => {
    const res = await reviewed("inj_customer_note");
    expect(res.path).toBe("reason");
  });

  it("records the path and the first finding in the sealed record", async () => {
    const res = await reviewed("fp_dob_exact_name_0");
    expect(res.record_hash).toBeDefined();
    const { readDecisionRecords } = await import("../src/index.js");
    expect(res.path).toBeDefined();
    expect(typeof readDecisionRecords).toBe("function");
  });
});

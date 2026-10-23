import { describe, expect, it } from "vitest";
import { DECISION_SYSTEM, runReview } from "../src/index.js";
import { caseFacts, sampleDeps, scriptedGenerator } from "./helpers.js";

/** The note a model gets when it cites something that is not a table, and the prompt line that prevents it. */
const c = caseFacts("fp_dob_exact_name_0");
const safe = JSON.stringify({ violation: false, category: "none", reasons: [] });
const approve = JSON.stringify({ verdict: "approve", issues: [] });
const citingComparison = JSON.stringify({
  decision: "CLOSE_FALSE_POSITIVE",
  confidence: 0.9,
  rationale: "The dates of birth conflict and the nationality differs.",
  facts: [{ table: "comparison", key_value: "x", column: "dob", value: "conflict" }],
  what_would_change: [],
});
const goodFacts = JSON.stringify({
  decision: "CLOSE_FALSE_POSITIVE",
  confidence: 0.9,
  rationale: "The dates of birth conflict and the nationality differs.",
  facts: [
    { table: "customer", key_value: c.customerId, column: "full_name", value: c.customerName },
    { table: "list_entry", key_value: c.entryId, column: "primary_name", value: c.entryName },
  ],
  what_would_change: [],
});

describe("a citation of a table that does not exist", () => {
  it("is sent back with the tables that may be cited, their keys, and a reminder that computed blocks are not tables", async () => {
    const { generator, requests } = scriptedGenerator([safe, citingComparison, approve, goodFacts, approve]);
    const res = await runReview(sampleDeps({ generator }), { runId: "cf-1", alertId: c.alertId, sampleMode: true });
    const retry = requests[3]?.prompt ?? "";
    expect(retry).toContain(
      'remove this citation; it cannot be cited: comparison.dob ("comparison" is worked out by code, not a table',
    );
    expect(retry).toContain("Cite only rows of these tables:");
    expect(retry).toMatch(/customer \(key customer_id\)/);
    expect(retry).toMatch(/list_entry \(key entry_id\)/);
    expect(retry).toContain("cannot be cited");
    expect(res.decision).toBe("CLOSE_FALSE_POSITIVE");
  });

  it("is prevented by a line in the decision prompt that names the tables and the computed blocks", () => {
    expect(DECISION_SYSTEM).toContain("Cite only the tables and columns listed in <citable>");
    expect(DECISION_SYSTEM).toContain(
      "not the comparison, definitions, data_quality, screener_facts, first_finding, ownership, earlier_decisions, identifier_overlap_types or date_of_birth_from_verified_note blocks, which are worked out by code, not tables",
    );
  });
});

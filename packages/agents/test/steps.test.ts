import { describe, expect, it } from "vitest";
import {
  gatherEvidence,
  judgeDifficulty,
  matchEvidence,
  renderDefinitions,
  renderEvidence,
  sampleRules,
  triage,
} from "../src/index.js";
import { caseFacts, sampleDeps } from "./helpers.js";

describe("gatherEvidence", () => {
  it("reads the semantic layer, then the alert, customer, list entry and data quality, masking identifiers", async () => {
    const deps = sampleDeps();
    const evidence = await gatherEvidence(deps, caseFacts("tm_identifier").alertId);
    expect(evidence.model.tables.map((t) => t.name)).toContain("business_definition");
    expect(evidence.alert.alert_id).toBe(caseFacts("tm_identifier").alertId);
    expect(evidence.customer.customer_id).toBe(caseFacts("tm_identifier").customerId);
    expect(evidence.customerIdentifiers[0]?.id_number).toMatch(/^\*+\d{2}$/);
    expect(evidence.identifierOverlap).toEqual(["passport"]);
    expect(evidence.dq.find((d) => d.rule === "dob_present_for_individuals")?.failed).toBe(true);
    expect(evidence.definitionCheck.mismatched).toEqual([]);
    expect(evidence.queries.every((q) => q.sql_hash.length === 64 && q.role === "role_evidence_agent")).toBe(true);
    expect(evidence.queries.some((q) => q.masked_columns?.includes("id_number"))).toBe(true);
    expect(evidence.citations.length).toBeGreaterThan(5);
  });
});

describe("matchEvidence and the model prompt", () => {
  it("compares field by field and gives the model explicit nationality facts and the approved wording", async () => {
    const deps = sampleDeps();
    const evidence = await gatherEvidence(deps, caseFacts("tm_exact_0").alertId);
    const match = matchEvidence(deps, evidence);
    expect(match.comparison).toMatchObject({
      assessment: "strong",
      dob: { status: "exact" },
      country: { status: "match" },
    });
    const payload = JSON.parse(renderEvidence(evidence, match));
    expect(payload.comparison.nationality.status).toBe("match");
    expect(payload.comparison.nationality.listed_nationalities).toContain(
      payload.comparison.nationality.customer_nationality,
    );
    expect(payload.customer_identifier).toEqual([]);
    const definitions = JSON.parse(renderDefinitions(evidence));
    expect(definitions.map((d: { id: string }) => d.id).sort()).toEqual([
      "counterparty_match",
      "effective_ownership_threshold",
      "false_positive",
      "strong_identifier",
      "true_match",
    ]);
  });
});

describe("triage", () => {
  it("plans the path and judges how clear the case is", async () => {
    const deps = sampleDeps();
    expect(triage(deps, "customer", caseFacts("fp_dob_exact_name_0").alertId)).toMatchObject({
      alertType: "customer",
      maxCriticRounds: 3,
    });
    const clear = matchEvidence(deps, await gatherEvidence(deps, caseFacts("fp_dob_exact_name_0").alertId));
    expect(judgeDifficulty(deps, clear)).toBe("clear");
    const contested = matchEvidence(deps, await gatherEvidence(deps, caseFacts("md_no_dob_0").alertId));
    expect(judgeDifficulty(deps, contested)).toBe("contested");
  });
});

describe("sampleRules", () => {
  it("answers the critic prompt with an approval and ignores prompts without evidence", () => {
    expect(JSON.parse(sampleRules({ prompt: "TASK: critic\n<evidence>{}</evidence>" }))).toEqual({
      verdict: "approve",
      issues: [],
    });
    const unknown = JSON.parse(sampleRules({ prompt: "TASK: decision\n<evidence>not json</evidence>" }));
    expect(unknown.decision).toBe("ESCALATE_L2");
    expect(JSON.parse(sampleRules({ prompt: "TASK: decision" })).decision).toBe("ESCALATE_L2");
  });
});

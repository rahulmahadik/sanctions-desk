import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gatherEvidence,
  judgeDifficulty,
  MAX_FIELD_CHARS,
  matchEvidence,
  renderDefinitions,
  renderEvidence,
  runReview,
  sampleRules,
  triage,
  truncateField,
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

describe("long text in a prompt", () => {
  it("is cut to a fixed length and says how much was left out", () => {
    expect(truncateField("short")).toBe("short");
    expect(truncateField(null)).toBeNull();
    const long = "x".repeat(MAX_FIELD_CHARS + 120);
    const cut = truncateField(long) ?? "";
    expect(cut.startsWith("x".repeat(MAX_FIELD_CHARS))).toBe(true);
    expect(cut).toContain("120 more characters left out");
    expect(cut.length).toBeLessThan(long.length);
  });

  it("applies to the evidence given to the model", async () => {
    const deps = sampleDeps();
    const evidence = await gatherEvidence(deps, caseFacts("inj_payment_reference_0").alertId);
    const longName = "y".repeat(900);
    if (evidence.payment) {
      evidence.payment.counterparty_name = longName;
      evidence.payment.payment_reference = "a free-text reference that must not be sent";
    }
    const payload = JSON.parse(renderEvidence(evidence, matchEvidence(deps, evidence)));
    expect(payload.payment.counterparty_name.length).toBeLessThan(400);
    expect(payload.payment.counterparty_name).toContain("more characters left out");
    // The payment reference is free text: the screener reads it locally and the model sees only its facts.
    expect(payload.payment).not.toHaveProperty("payment_reference");
    expect(payload.list_entry).not.toHaveProperty("remarks");
  });
});

describe("the ownership step", () => {
  it("writes the register into the World Model and evaluates the 50 percent rule on what it reads back", async () => {
    const deps = sampleDeps();
    const facts = caseFacts("ob_chain_42");
    const result = await runReview(deps, { runId: "ownership-world", alertId: facts.alertId, sampleMode: true });
    expect(result.decision).toBe("ESCALATE_L2");
    const events = readdirSync(deps.logDir)
      .filter((f) => f.startsWith("trace-") && f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(deps.logDir, f), "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l) as { agent: string; action: string; detail?: Record<string, unknown> });
    const evaluate = events.find((e) => e.agent === "ownership" && e.action === "evaluate");
    expect(evaluate?.detail).toMatchObject({ cascade: "blocked", world_model: { rows: 2 } });
    const world = evaluate?.detail?.world_model as { audit_events: number } | undefined;
    expect(world?.audit_events).toBeGreaterThan(2);
  });
});

import {
  type DecisionRecord,
  loadConfig,
  sealDecisionRecord,
  sha256Hex,
  type TraceEvent,
} from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { buildTraceContract, type ListChangeReport, renderCaseFile, renderReplayFile } from "../src/index.js";

const sha = (c: string) => c.repeat(64);
const costs = loadConfig({ env: {} }).costs;

const record = (over: Partial<Parameters<typeof sealDecisionRecord>[0]> = {}): DecisionRecord =>
  sealDecisionRecord({
    record_id: "rec-1",
    run_id: "run-1",
    alert_type: "customer",
    alert_ref: "ALR-1",
    decided_at: "2026-10-22T12:00:00.000Z",
    as_of: "2026-10-22T11:00:00.000Z",
    decision: "NEED_MORE_INFO",
    confidence: 0.5,
    confidence_cap: { value: 0.6, reason: "data-quality rule failed | on the customer" },
    rationale: "The customer has no date of birth.",
    what_would_change: ["A verified date of birth"],
    policy: { version: 1, hash: sha("a") },
    definitions: [{ definition_id: "true_match", version: "1", statement_hash: sha("b") }],
    usl: { namespace: "ns", model_version: "v1" },
    list_snapshots: [{ list: "OFAC", snapshot_id: "ofac-1" }],
    queries: [
      {
        query_id: "q1",
        agent: "evidence",
        role: "role_evidence_agent",
        table: "t",
        sql: "SELECT 1",
        sql_hash: sha256Hex("SELECT 1"),
        row_count: 1,
        row_hashes: [sha("c")],
        masked_columns: ["id_number"],
        token_source: "fallback",
      },
    ],
    memories: [],
    models: [
      {
        agent: "decision",
        model_requested: "meterless/deep",
        model_routed: "nvidia/nemotron-3-ultra-550b-a55b",
        provider: "nightshift",
        route_kind: "cloud",
        thinking: "off",
        tokens_in: 100,
        tokens_out: 10,
      },
    ],
    guards: [{ guard: "data_quality", verdict: "block", detail: "customer fails dob_present" }],
    critic: { rounds: 1, final_verdict: "approved" },
    ...over,
  });

const events: TraceEvent[] = [
  { ts: "t", run_id: "run-1", seq: 0, agent: "system", action: "run_started", status: "ok", output_summary: "started" },
  {
    ts: "t",
    run_id: "run-1",
    seq: 1,
    agent: "evidence",
    action: "find_customer",
    status: "ok",
    output_summary: "1 rows",
  },
  {
    ts: "t",
    run_id: "run-1",
    seq: 2,
    agent: "decision",
    action: "model_answer",
    status: "ok",
    output_summary: "valid answer",
  },
  {
    ts: "t",
    run_id: "run-1",
    seq: 3,
    agent: "policy_guard",
    action: "apply_policy",
    status: "ok",
    output_summary: "raised to NEED_MORE_INFO",
  },
];

describe("renderCaseFile", () => {
  const rec = record();
  const text = renderCaseFile({
    title: "Customer with no date of birth",
    summary: "A short summary.",
    record: rec,
    events,
    contract: buildTraceContract(rec, costs),
    files: { record: "r.json", trace: "t.json", events: "e.jsonl" },
  });

  it("states the recommendation, the cap and what would change it", () => {
    expect(text).toContain("# Customer with no date of birth");
    expect(text).toContain("**Need more information** · confidence 50% (capped at 60%");
    expect(text).toContain("- A verified date of birth");
  });

  it("lists the steps that found something but not the model's raw answers or the run markers", () => {
    expect(text).toContain("1. **evidence** (find customer): 1 rows");
    expect(text).toContain("2. **policy guard** (apply policy): raised to NEED_MORE_INFO");
    expect(text).not.toContain("valid answer");
    expect(text).not.toContain("started");
  });

  it("answers the four questions and names the model and lane for each step", () => {
    expect(text).toContain("true match v1");
    expect(text).toContain("labelled fallback key; masked: id_number");
    expect(text).toContain("1 model calls (0 local, 1 cloud)");
    expect(text).toMatch(/\| decision \| meterless\/deep \| nvidia\/nemotron-3-ultra-550b-a55b \| cloud \|/);
  });

  it("keeps table cells intact and ends with the record hash and links", () => {
    expect(text).toContain("| data quality | block | customer fails dob_present |");
    expect(text).toContain(rec.record_hash);
    expect(text).toContain("[Decision record](r.json)");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says nothing about a cap or model table when there is none", () => {
    const bare = record({ confidence_cap: undefined, models: [], what_would_change: [] });
    const out = renderCaseFile({
      title: "t",
      summary: "s",
      record: bare,
      events: [],
      contract: buildTraceContract(bare, costs),
      files: { record: "r", trace: "t", events: "e" },
    });
    expect(out).not.toContain("capped");
    expect(out).not.toContain("Which model answered");
    expect(out).not.toContain("What would change");
  });
});

describe("renderReplayFile", () => {
  const candidate = {
    disposition_id: "D1",
    customer_id: "CUST-1",
    entry_id: "OFAC-1",
    earlier_decision: "CLEARED",
    reason_code: "FALSE_POSITIVE_CONFIRMED",
    earlier_hash: sha("a"),
    entry_name: "JANE DOE",
    open_alert_ids: ["ALR-9"],
  } as unknown as ListChangeReport["reopen"][number];
  const report: ListChangeReport = {
    total: 13,
    examined: 13,
    batches: 1,
    complete: true,
    next_cursor: null,
    reopen: [candidate],
    release: [{ ...candidate, customer_id: "CUST-2", open_alert_ids: [] }],
    unchanged: 10,
    moot: 0,
    impact: { customers: 2, pending_payments: 3, pending_amount_by_currency: {}, summary: "affects 2 customers" },
  };
  const text = renderReplayFile({
    title: "A list update",
    summary: "s",
    report,
    policyVersion: 1,
    files: { report: "r.json" },
  });

  it("summarises the counts, the impact and both tables", () => {
    expect(text).toContain("13 of 13 earlier decisions");
    expect(text).toContain("1 should be looked at again, 1 are candidates for a person to release, 10 are unchanged");
    expect(text).toContain("**Portfolio impact:** affects 2 customers");
    expect(text).toContain("| CUST-1 | JANE DOE | CLEARED (FALSE_POSITIVE_CONFIRMED) | ALR-9 |");
    expect(text).toContain("| CUST-2 | JANE DOE | CLEARED (FALSE_POSITIVE_CONFIRMED) | none open |");
    expect(text).toContain("does not release anything");
  });
});

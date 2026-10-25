import {
  type DecisionRecord,
  type HumanAction,
  loadConfig,
  sealDecisionRecord,
  sha256Hex,
  type TraceEvent,
} from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  buildTraceContract,
  humanActionText,
  type ListChangeReport,
  renderCaseFile,
  renderReplayFile,
} from "../src/index.js";

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

describe("renderCaseFile after people have acted", () => {
  const files = { record: "r.json", trace: "t.json", events: "e.jsonl" };
  const render = (rec: DecisionRecord, extra: Partial<Parameters<typeof renderCaseFile>[0]> = {}) =>
    renderCaseFile({
      title: "t",
      summary: "s",
      record: rec,
      events,
      contract: buildTraceContract(rec, costs),
      files,
      ...extra,
    });

  it("lists who acted, with role, outcome, time and reason, and the records prepared next with their seal", () => {
    const rec = record({
      human: [
        {
          action: "approve",
          actor: "ana",
          role: "analyst",
          at: "2026-10-23T10:00:00.000Z",
          reason: "Dates differ | by years",
          outcome: "NEED_MORE_INFO",
        },
      ],
    });
    const text = render(rec, {
      actions: [
        {
          action_id: "rfi_draft-1",
          body: {
            kind: "rfi_draft",
            alert_id: "ALR-1",
            alert_type: "customer",
            record_hash: sha("d"),
            recommended: "NEED_MORE_INFO",
            final: "NEED_MORE_INFO",
            status: "draft, not sent",
            title: "x",
            content: "Please send a recent proof of address.",
            decided_by: [],
            policy: { version: 1, hash: sha("a") },
            sent: false,
            created_at: "2026-10-23T10:00:01.000Z",
          },
          body_hash: sha("e"),
          seal: { type: "hash-sealed" },
        },
      ],
    });
    expect(text).toContain("## What people did");
    expect(text).toContain("Status: decided by a person.");
    expect(text).toContain(
      "| ana | analyst | approved | Need more information | 2026-10-23T10:00:00.000Z | Dates differ / by years |",
    );
    expect(text).toContain("## What was prepared next");
    expect(text).toContain("Nothing here was sent or executed.");
    expect(text).toContain(
      "rfi draft | draft, not sent | hash-sealed (no signing key configured) | Please send a recent proof of address.",
    );
  });

  const at = "2026-10-23T10:00:00.000Z";
  const act = (action: HumanAction["action"], actor: string, outcome?: HumanAction["outcome"]): HumanAction => ({
    action,
    actor,
    role: "approver",
    at,
    reason: `${actor} gave a reason`,
    ...(outcome ? { outcome } : {}),
  });
  it.each([
    {
      name: "a declined override to a close",
      decision: "ESCALATE_L2" as const,
      human: [act("override", "ana", "CLOSE_FALSE_POSITIVE"), act("reject", "bob", "ESCALATE_L2")],
      status: "the override to a close was declined by the second approver; escalated",
      row: "| bob | approver | declined the close | Escalate to level 2 |",
      never: "declined the block",
    },
    {
      name: "a declined block",
      decision: "RECOMMEND_BLOCK" as const,
      human: [act("approve", "ana", "RECOMMEND_BLOCK"), act("reject", "bob", "ESCALATE_L2")],
      status: "the block was declined by the second approver; escalated",
      row: "| bob | approver | declined the block | Escalate to level 2 |",
      never: "declined the close",
    },
    {
      name: "a second approval of a close",
      decision: "ESCALATE_L2" as const,
      human: [act("override", "ana", "CLOSE_FALSE_POSITIVE"), act("second_approval", "bob", "CLOSE_FALSE_POSITIVE")],
      status: "an override to a close, approved by two people",
      row: "| bob | approver | gave the second approval | Close as a false positive |",
      never: "declined",
    },
  ])("names $name in the people table in plain words", ({ decision, human, status, row, never }) => {
    const text = render(record({ decision, human }));
    expect(text).toContain(`Status: ${status}.`);
    expect(text).toContain(row);
    expect(text).not.toContain(never);
    expect(text).not.toContain("| reject |");
  });

  it.each([
    ["approve", "decided", "approved"],
    ["override", "decided", "overrode"],
    ["second_approval", "block_approved", "gave the second approval"],
    ["reject", "block_declined", "declined the block"],
    ["reject", "override_declined", "declined the close"],
    ["reopen", "awaiting", "reopened the automatic close"],
  ])("says %s (status %s) as %j", (action, status, words) => {
    expect(humanActionText(action, status)).toBe(words);
  });

  it("says that nobody has acted yet, and leaves out the prepared records", () => {
    const text = render(record());
    expect(text).toContain("No person has acted on this recommendation yet.");
    expect(text).not.toContain("## What was prepared next");
  });

  it("states an automatic close in the words of the record, a QA sample, the path, and a date taken from a verified note", () => {
    const rec = record({
      review_path: "confirm",
      first_finding: "CLOSE_FALSE_POSITIVE",
      autonomy: {
        policy_level: 1,
        level_in_force: 1,
        outcome: "auto_closed",
        conditions: [{ name: "level_one", met: true }],
        qa_draw: 0.5,
        qa_rate: 0.1,
        statement: "closed automatically under policy v4, level 1, conditions met: level_one",
      },
      documentary: [
        {
          field: "date_of_birth",
          value: "1975-03-02",
          source: "customer.notes",
          check_reference: "KYC-482113",
          label: "date of birth from verified note (check ref KYC-482113)",
        },
      ],
    });
    const text = render(rec, { facts: [{ label: "Customer", value: "A B" }] });
    expect(text).toContain("Status: closed automatically; a person can reopen it.");
    expect(text).toContain("**closed automatically under policy v4, level 1, conditions met: level_one.**");
    expect(text).toContain("the structured evidence settles the case");
    expect(text).toContain("date of birth from verified note (check ref KYC-482113): **1975-03-02**");
    expect(text).toContain("not a value of the customer record");
    expect(text).toContain("- **Customer:** A B");
    const sampled = render(
      record({
        autonomy: {
          policy_level: 1,
          level_in_force: 1,
          outcome: "qa_sample",
          conditions: [],
          qa_draw: 0.01,
          qa_rate: 0.1,
        },
      }),
    );
    expect(sampled).toContain("picked at random for a quality-assurance review");
  });
});

import type { EvidenceView, RecordView, ReviewAnswer, RunEvent, TraceView } from "../lib/types";

let seq = 0;
export const ev = (agent: string, action: string, over: Partial<RunEvent> = {}): RunEvent => ({
  ts: "2026-10-23T00:00:00.000Z",
  run_id: "run-1",
  seq: seq++,
  agent,
  action,
  status: "ok",
  ...over,
});

/** A review that is sent back once by the critic, then approved. */
export const EVENTS: RunEvent[] = (() => {
  seq = 0;
  return [
    ev("system", "run_started"),
    ev("triage", "plan"),
    ev("evidence", "find_alert", { output_summary: "1 rows" }),
    ev("matching", "compare_party", { output_summary: "weak: name 1.00" }),
    ev("decision", "model_answer", {
      model_used: "nvidia/nemotron-3-ultra-550b-a55b",
      route_kind: "cloud",
      latency_ms: 21000,
      output_summary: "valid answer on attempt 1",
    }),
    ev("critic", "judge", { status: "blocked", output_summary: "rejected: fact does not match" }),
    ev("decision", "model_answer", { status: "retry", output_summary: "the model answer has no JSON object" }),
    ev("decision", "model_answer", { model_used: "local-runtime/nemotron-3.5-lightning-30b-a3b", route_kind: "local" }),
    ev("critic", "judge", { output_summary: "approved" }),
    ev("policy_guard", "apply_policy", { output_summary: "stands" }),
    ev("reporter", "seal_record"),
    ev("system", "run_completed"),
  ];
})();

export const ANSWER: ReviewAnswer = {
  run_id: "run-1",
  status: "ok",
  decision: "CLOSE_FALSE_POSITIVE",
  confidence: 0.9,
  rationale: "Different birth date and nationality.",
  what_would_change: ["A matching identifier number"],
  key_evidence: [
    "Comparison: name 1.00 (exact)",
    "Comparison: date of birth conflicts (1990 against 1975)",
    "Check: data quality: the customer record fails dob_present_for_individuals",
  ],
  guards: [{ guard: "jurisdiction", verdict: "pass", detail: "no watched jurisdiction" }],
  critic: { rounds: 2, final_verdict: "approved" },
  record_hash: "a".repeat(64),
  approvals_required: 1,
  sample_mode: true,
  sample_notice: "Saved answers.",
  execution_time_seconds: 3,
};

export const EVIDENCE: EvidenceView = {
  alert: { alert_id: "ALR-0001" },
  customer: {
    customer_id: "CUST-0001",
    customer_type: "individual",
    full_name: "Jane Doe",
    date_of_birth: "1990-01-01",
    nationality: "GB",
    residence_country: "GB",
    notes: null,
  },
  payment: {
    payment_id: "PAY-1",
    counterparty_name: "Acme",
    counterparty_country: "IR",
    beneficiary_bank_country: "CU",
  },
  list_entry: {
    entry_id: "OFAC-1",
    list_id: "OFAC",
    party_kind: "individual",
    primary_name: "JANE DOE",
    listed_on: "2020-01-01",
    remarks: null,
  },
  list_aliases: [{ alias_name: "J DOE" }],
  list_dobs: [{ dob_value: "1975" }],
  list_countries: [{ country_name: "Iran", role: "nationality" }],
  customer_identifiers: [{ id_type: "passport", id_number: "******56" }],
  list_identifiers: [],
  identifier_overlap: [],
  data_quality: [{ table: "customer", rule: "dob_present_for_individuals", failed: true }],
  definitions: [{ definition_id: "true_match", version: "1" }],
  queries: [
    {
      query_id: "q1",
      table: "lightning.metastore.sanctions.screening_usl.customer_identifier",
      row_count: 1,
      masked_columns: ["id_number"],
    },
  ],
};

export const TRACE: TraceView = {
  case: { alert_ref: "ALR-0001", record_id: "rec-1", run_id: "run-1", decided_at: "2026-10-23T00:00:00.000Z" },
  record: { hash: "b".repeat(64), verified: true },
  definitions: [{ definition_id: "true_match", version: "1" }],
  data: {
    usl: { namespace: "lightning.metastore.sanctions", model_version: "v1" },
    list_snapshots: [{ list_id: "OFAC", snapshot_id: "ofac-2026" }],
    queries: [{ query_id: "q1", agent: "evidence", table: "alert", rows: 1 }],
  },
  access: {
    policy: { version: 1 },
    by_role: [{ role: "role_evidence_agent", queries: 12, token_source: "fallback", masked_columns: ["id_number"] }],
    note: "",
  },
  cost: {
    currency: "USD",
    assumption: "Unit costs are assumptions.",
    models: [
      {
        agent: "decision",
        model_requested: "meterless/deep",
        model_routed: "nvidia/nemotron-3-ultra-550b-a55b",
        route_kind: "cloud",
        reasoning: "budget 500 tokens",
        tokens_in: 3000,
        tokens_out: 500,
        latency_ms: 21000,
        receipt_status: "valid_pinned",
        cost: 0.02,
      },
    ],
    data_queries: { count: 12, total_latency_ms: 900, rows_returned: 30, cache_hits: 12, cost: 0 },
    totals: { tokens_in: 3000, tokens_out: 500, local_calls: 0, cloud_calls: 1, total_cost: 0.02 },
  },
};

export const RECORD: RecordView = {
  decision: "CLOSE_FALSE_POSITIVE",
  confidence: 0.9,
  rationale: "r",
  as_of: "2026-10-22T00:00:00.000Z",
  decided_at: "2026-10-23T00:00:00.000Z",
  policy: { version: 1 },
  definitions: [{ definition_id: "true_match", version: "1" }],
  list_snapshots: [],
  critic: { rounds: 2, final_verdict: "approved" },
  human: [],
  record_hash: "b".repeat(64),
};

export const SPLIT = {
  rows: [
    {
      step: "Safety guard",
      calls: 48,
      models: [{ model: "local-runtime/nemotron-3.5-lightning-30b-a3b", kind: "local" as const, calls: 48, share: 1 }],
    },
    {
      step: "Decision",
      calls: 69,
      models: [{ model: "nvidia/nemotron-3-ultra-550b-a55b", kind: "cloud" as const, calls: 69, share: 1 }],
    },
    {
      step: "Critic",
      calls: 68,
      models: [
        { model: "nvidia/nemotron-3-ultra-550b-a55b", kind: "cloud" as const, calls: 65, share: 0.9559 },
        { model: "local-runtime/nemotron-3.5-lightning-30b-a3b", kind: "local" as const, calls: 3, share: 0.0441 },
      ],
    },
  ],
  receipts: 185,
  mode_coerced: 120,
  routed_auto: 185,
  routers: ["learned-router"],
};

import type { HumanView, MeView } from "../lib/types";

const PERMS_NONE = {
  decide: false,
  approve_block: false,
  override_towards_less_caution: false,
  propose_policy: false,
  publish_policy: false,
};
const DEMO = [
  { id: "analyst_demo", role: "analyst" },
  { id: "approver_demo", role: "approver" },
  { id: "admin_demo", role: "policy_admin" },
];
export const ME_VIEWER: MeView = {
  user: { id: "anonymous", role: "viewer", demo: false },
  auth: "demo",
  demo_users: DEMO,
  permissions: PERMS_NONE,
  records_sealed_with: "hash-sealed",
};
export const ME_ANALYST: MeView = {
  ...ME_VIEWER,
  user: { id: "analyst_demo", role: "analyst", demo: true },
  permissions: { ...PERMS_NONE, decide: true },
};
export const ME_APPROVER: MeView = {
  ...ME_VIEWER,
  user: { id: "approver_demo", role: "approver", demo: true },
  permissions: {
    decide: true,
    approve_block: true,
    override_towards_less_caution: true,
    propose_policy: true,
    publish_policy: false,
  },
};

const base: HumanView = {
  alert_id: "ALR-0001",
  record_hash: "a".repeat(64),
  recommendation: { decision: "CLOSE_FALSE_POSITIVE", confidence: 0.9, rationale: "Dates of birth conflict." },
  autonomy: null,
  status: "awaiting",
  final: null,
  actions_taken: [],
  records_sealed_with: "hash-sealed",
  next_actions: [],
};
const note = (kind: HumanView["next_actions"][number]["body"]["kind"], status: string, content: string) => ({
  action_id: `${kind}-1`,
  body: {
    kind,
    status,
    title: kind,
    content,
    final: "CLOSE_FALSE_POSITIVE" as const,
    sent: false as const,
    created_at: "2026-10-23T10:00:00.000Z",
    decided_by: [],
  },
  body_hash: "b".repeat(64),
  seal: { type: "hash-sealed" as const },
  check: "hash_sealed" as const,
});
const taken = (
  actor: string,
  role: string,
  action: HumanView["actions_taken"][number]["action"],
  outcome: HumanView["final"],
) => ({
  action,
  actor,
  role,
  at: "2026-10-23T10:00:00.000Z",
  reason: "A reason that was given.",
  ...(outcome ? { outcome } : {}),
});
export const HUMAN = {
  awaiting: base,
  decided: {
    ...base,
    status: "decided",
    final: "CLOSE_FALSE_POSITIVE",
    actions_taken: [taken("analyst_demo", "analyst", "approve", "CLOSE_FALSE_POSITIVE")],
    next_actions: [
      note("closure_note", "closed by a person", "Alert ALR-0001 was closed as a false positive by analyst_demo."),
    ],
  } satisfies HumanView,
  blockPending: {
    ...base,
    recommendation: { decision: "RECOMMEND_BLOCK", confidence: 0.9, rationale: "x" },
    status: "block_pending",
    actions_taken: [taken("analyst_demo", "analyst", "approve", "RECOMMEND_BLOCK")],
    next_actions: [note("escalation_ticket", "block approval pending", "A block is recommended and has one approval.")],
  } satisfies HumanView,
  blockApproved: {
    ...base,
    recommendation: { decision: "RECOMMEND_BLOCK", confidence: 0.9, rationale: "x" },
    status: "block_approved",
    final: "RECOMMEND_BLOCK",
    actions_taken: [
      taken("analyst_demo", "analyst", "approve", "RECOMMEND_BLOCK"),
      taken("approver_demo", "approver", "second_approval", "RECOMMEND_BLOCK"),
    ],
    next_actions: [
      note("block_recommendation", "ready for the sanctions officer", "Two different approvers support a block."),
    ],
  } satisfies HumanView,
};

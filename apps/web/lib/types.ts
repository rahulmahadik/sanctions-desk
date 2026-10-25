/** The parts of the API's answers that the interface reads. The API validates them; this only names them. */

export type Decision = "CLOSE_FALSE_POSITIVE" | "ESCALATE_L2" | "RECOMMEND_BLOCK" | "NEED_MORE_INFO";

export interface QueueAlert {
  alert_id: string;
  alert_type: string;
  alert_source: string;
  customer_id: string;
  entry_id: string;
  matched_name: string;
  match_score: number;
  status: string;
  recommendation: Decision | null;
  record_hash: string | null;
  /** Where people have taken the recommendation; absent when the API predates the human step. */
  human_status?: HumanStatus;
  human_final?: Decision | null;
  autonomy_outcome?: AutonomyOutcome | null;
  /** How strong the name match is, from the match score and the policy's name threshold. */
  severity?: Severity;
  /** The checks that stopped a close the decision step proposed, read from the run's trace; empty otherwise. */
  blocked_by?: StoppedBy[];
}

export type Severity = "high" | "medium" | "low";
export type StoppedBy = "critic" | "policy guard" | "screener" | "data quality";

/** Whether a close was proposed and stopped in the latest review, and by what (null when its trace is gone). */
export interface CloseStopView {
  stopped: boolean;
  by: StoppedBy[];
  reasons: string[];
}

export interface RunEvent {
  ts: string;
  run_id: string;
  seq: number;
  agent: string;
  action: string;
  status: "ok" | "error" | "retry" | "blocked" | "skipped";
  input_summary?: string;
  output_summary?: string;
  confidence?: number;
  retry_count?: number;
  model_requested?: string;
  model_used?: string;
  route_kind?: "local" | "cloud" | null;
  /** Who answered: "nightshift", "ollama" (the local backup, no receipt) or "fallback-rules" (the sample stand-in). */
  provider?: string;
  /** `verification` is the desk's check of the signed receipt when the call was made. */
  receipt?: { receipt_id: string; verification?: string };
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  zetaris_query_id?: string;
  detail?: Record<string, unknown>;
}

export interface ReviewAnswer {
  run_id: string;
  status: "ok" | "error";
  decision?: Decision;
  confidence?: number;
  rationale?: string;
  what_would_change: string[];
  /** The two or three lines of evidence that decided the case. */
  key_evidence?: string[];
  /** Set when the confidence was capped, with the reason. */
  confidence_cap?: { value: number; reason: string };
  guards?: Array<{ guard: string; verdict: "pass" | "flag" | "block"; detail?: string }>;
  critic?: {
    rounds: number;
    final_verdict: string;
    /** Citations set aside from the second round on because their source cannot be cited at all. */
    not_citable?: Array<{ table: string; column: string; reason: string; round: number }>;
  };
  record_hash?: string;
  approvals_required?: number;
  sample_mode?: boolean;
  sample_notice?: string;
  path?: "confirm" | "reason";
  first_finding?: Decision;
  autonomy?: { outcome: AutonomyOutcome; statement?: string; policy_level: 0 | 1; level_in_force: 0 | 1 };
  human_review_required?: boolean;
  execution_time_seconds: number;
  error?: { type: string; message: string };
}

export type Row = Record<string, string | null>;

export interface EvidenceView {
  alert: Row;
  customer: Row;
  payment: Row | null;
  list_entry: Row;
  list_aliases: Row[];
  list_dobs: Row[];
  list_countries: Row[];
  customer_identifiers: Row[];
  list_identifiers: Row[];
  identifier_overlap: string[];
  data_quality: Array<{ table: string; rule: string; failed: boolean }>;
  definitions: Array<{ definition_id: string; version: string; statement?: string }>;
  queries: Array<{
    query_id: string;
    table: string;
    row_count: number;
    masked_columns: string[];
    token_source?: string;
  }>;
}

export interface TraceView {
  close_stop?: CloseStopView | null;
  case: { alert_ref: string; record_id: string; run_id: string; decided_at: string };
  record: { hash: string; verified: boolean };
  definitions: Array<{ definition_id: string; version: string }>;
  data: {
    usl: { namespace: string; model_version: string };
    list_snapshots: Array<{ list: string; snapshot_id: string }>;
    queries: Array<{
      query_id: string;
      agent: string;
      table: string;
      rows: number;
      latency_ms?: number;
      cache_hit?: boolean;
    }>;
  };
  access: {
    policy: { version: number };
    by_role: Array<{ role: string; queries: number; token_source: string; masked_columns: string[] }>;
    note: string;
  };
  cost: {
    currency: string;
    assumption: string;
    models: Array<{
      agent: string;
      model_requested: string;
      model_routed: string;
      route_kind: string | null;
      reasoning: string;
      tokens_in?: number;
      tokens_out?: number;
      latency_ms?: number;
      receipt_status: string;
      receipt_id?: string;
      app?: string;
      cost: number;
    }>;
    data_queries: { count: number; total_latency_ms: number; rows_returned: number; cache_hits: number; cost: number };
    totals: { tokens_in: number; tokens_out: number; local_calls: number; cloud_calls: number; total_cost: number };
  };
}

export interface ReceiptCheck {
  receipt_id: string;
  status: "valid_pinned" | "valid_unpinned" | "invalid" | "malformed";
  reason?: string;
  body_hash: string | null;
  signer_public_key: string | null;
  key_pinned: boolean;
  app: string | null;
  requested_mode: string | null;
  routed_mode: string | null;
  mode_coerced: boolean | null;
  served_by: string | null;
  route_kind: string | null;
}

export interface RecordView {
  decision: Decision;
  confidence: number;
  rationale: string;
  as_of: string;
  decided_at: string;
  policy: { version: number };
  definitions: Array<{ definition_id: string; version: string }>;
  list_snapshots: Array<{ list: string; snapshot_id: string }>;
  critic: { rounds: number; final_verdict: string };
  human: unknown[];
  record_hash: string;
  review_path?: "confirm" | "reason";
  first_finding?: Decision;
  documentary?: DocumentaryValue[];
  screener?: ScreenerRecordView;
}

/** One risk signal as the sealed record keeps it: where it points, never the text. */
export interface ScreenerSignalView {
  type: string;
  confidence: number;
  /** "customer.notes:12-40", or "customer.notes:unlocated" when the span does not point into the field. */
  span_id: string;
  span_valid: boolean;
  /** Absent in records made before policy version 7. */
  grounded?: boolean;
  grounding_reason?: string;
}

export interface ScreenerRecordView {
  status: "ok" | "nothing_to_read" | "failed" | "off";
  fields_read: string[];
  signals: ScreenerSignalView[];
}

export interface DocumentaryValue {
  field: "date_of_birth";
  value: string;
  source: string;
  check_reference: string;
  label: string;
}

interface ExamMetrics {
  cases: number;
  errors: number;
  exact_accuracy: number;
  acceptable_accuracy: number;
  risk_cases: number;
  false_closes: number;
  false_close_rate: number;
  by_group: Record<string, { cases: number; exact: number; acceptable: number }>;
  latency_s: { mean: number; p50: number; p95: number };
  model_calls: { local: number; cloud: number; cloud_share: number };
  cost: { total: number; per_case: number };
  tokens: { in: number; out: number };
}

export interface ExamResult {
  file: string;
  variant: string;
  /** Absent for the 70-case exam; "heldout", "heldout2"… for a held-out set. */
  exam?: string;
  /** Absent for the first system; a later system version's tag otherwise. */
  system?: string;
  tag?: string;
  selection?: { kinds?: unknown; groups?: unknown; limit?: unknown };
  started_at: string;
  metrics: ExamMetrics;
}

export interface Headline {
  alerts: number;
  closed_with_evidence: number;
  closed_correctly: number;
  escalated: number;
  closed_share: number;
  escalated_share: number;
  risk_cases: number;
  false_closes: number;
  false_close_rate: number;
  true_match_cases: number;
  true_match_false_closes: number;
  decision_unavailable: number;
  minutes_saved_per_100_alerts: number;
  assumptions: {
    minutesPerAlert: number;
    minutesToConfirmClose: number;
    manualMinutesRange?: { low: number; high: number };
  };
  per_alert?: {
    alerts: number;
    median_seconds: number;
    mean_seconds: number;
    p95_seconds: number;
    mean_cost: number;
    manual_seconds: { low: number; high: number } | null;
    times_faster: { low: number; high: number } | null;
    note: string;
  };
}

export interface RoutingSplit {
  rows: Array<{
    step: string;
    calls: number;
    models: Array<{ model: string; kind: "cloud" | "local" | "unknown"; calls: number; share: number }>;
  }>;
  receipts: number;
  mode_coerced: number;
  routed_auto: number;
  routers: string[];
}

export interface ExamAnswer {
  label: string;
  cases: number;
  results: ExamResult[];
  policy_version: number;
  headline?: Headline | null;
  headline_sentence?: string | null;
  headline_run?: string | null;
  routing_split?: RoutingSplit | null;
  heldout_rounds?: HeldoutRoundView[];
  /** The newest complete run of the newest system version, with its measured time per alert. */
  current_run?: {
    name: string;
    system: string;
    exam: string;
    started_at: string;
    alerts: number;
    median_seconds: number;
  } | null;
}

interface RoundCellView {
  file: string;
  risk: number;
  wrong_closes: number;
  wrong_close_ids: string[];
  clears: number;
  clears_made: number;
  text: string;
}

/** One held-out round as run, with the baselines on the same cases (GET /exam). */
export interface HeldoutRoundView {
  id: string;
  label: string;
  system: string;
  commit: string;
  blind: boolean;
  cells: Record<"routed" | "single" | "rules" | "fuzzy" | "escalate_all", RoundCellView | null>;
}

export interface GovernanceView {
  mapping_note: string;
  inventory: {
    name: string;
    purpose: string;
    status: string;
    deployment: string;
    data: string;
    models: Array<{ name: string; served: string; used_by: string[] }>;
    which_model_serves: string;
    components: string[];
    policy_version: number;
    sample_mode: boolean;
  };
  risk_materiality: {
    kind: string;
    dimensions: Array<{ dimension: string; rating: string; basis: string }>;
    conclusion: string;
  };
  human_oversight: {
    hard_limits: Record<string, string | number | boolean>;
    controls: string[];
    proportionate_to_risk?: {
      principle: string;
      level_0: string;
      level_1: string;
      always_to_a_person: string[];
      current: { policy_level: 0 | 1; version: number };
      change_control: string;
    };
  };
  explainability: { record: string; evidence: string; where: string[] };
  testing: {
    exam_report: string;
    headline: Headline | null;
    headline_sentence: string | null;
    headline_run: string | null;
    baselines: string;
    label_changes: Array<{ case_id: string; reason: string }>;
    limits: string;
  };
  monitoring: {
    model_ledger: string;
    routing_split: RoutingSplit | null;
    json_failure_rate: { note: string; before: unknown[]; after: unknown[] } | null;
    provider_failures: string;
    access: string;
  };
  change_control: {
    active_policy_version: number;
    policy_versions: Array<{
      version: number;
      status: string;
      proposed_by: string;
      approved_by: string | null;
      published_at: string | null;
    }>;
    audit_entries: number;
    rule: string;
    code: string;
  };
  limits: string[];
}

export type HumanStatus =
  | "awaiting"
  | "auto_closed"
  | "decided"
  | "block_pending"
  | "block_approved"
  | "block_declined"
  | "override_pending"
  | "override_approved"
  | "override_declined";
export type AutonomyOutcome = "human_review" | "auto_closed" | "qa_sample";
export type ActionCheck = "signed_and_pinned" | "signed_unpinned" | "hash_sealed" | "invalid";

export interface MeView {
  user: { id: string; role: "analyst" | "approver" | "policy_admin" | "viewer"; demo: boolean };
  auth: "on" | "demo" | "off";
  demo_users: Array<{ id: string; role: string }>;
  permissions: {
    decide: boolean;
    approve_block: boolean;
    override_towards_less_caution: boolean;
    propose_policy: boolean;
    publish_policy: boolean;
  };
  records_sealed_with: "ed25519" | "hash-sealed";
  signing_public_key?: string;
}

export interface HumanActionView {
  action: "approve" | "override" | "second_approval" | "reject" | "reopen";
  actor: string;
  role?: string;
  at: string;
  reason?: string;
  outcome?: Decision;
}

export interface ActionRecordView {
  action_id: string;
  body: {
    kind: "closure_note" | "escalation_ticket" | "rfi_draft" | "hold_instruction" | "block_recommendation";
    status: string;
    title: string;
    content: string;
    final: Decision;
    sent: false;
    created_at: string;
    decided_by: Array<{ id: string; role?: string; action: string; at: string; reason?: string }>;
  };
  body_hash: string;
  seal: { type: "hash-sealed" } | { type: "ed25519"; key_id: string };
  check: ActionCheck;
}

export interface HumanView {
  alert_id: string;
  record_hash: string;
  recommendation: { decision: Decision; confidence: number; rationale: string };
  autonomy: { outcome: AutonomyOutcome; statement: string | null; level_in_force: 0 | 1 } | null;
  status: HumanStatus;
  final: Decision | null;
  actions_taken: HumanActionView[];
  records_sealed_with: "ed25519" | "hash-sealed";
  next_actions: ActionRecordView[];
}

interface AutonomySettings {
  level: 0 | 1;
  autoClose: { confidenceAtLeast: number; qaSampleRate: number; dailyCap: number };
}

export interface AutonomyView {
  policy_version: number;
  policy_level: 0 | 1;
  level_in_force: 0 | 1;
  kill_switch: { active: boolean; by?: string; at?: string; reason?: string };
  settings: AutonomySettings;
  today: { day: string; auto_closed: number; qa_sample: number; reopened: number; cap: number };
  locked: string[];
}

export interface AutoClosedItem {
  alert_id: string;
  record_hash: string;
  decided_at: string;
  statement: string;
  policy_version: number;
  confidence: number;
  rationale: string;
  status: HumanStatus;
  reopened_by: string | null;
}

export interface PolicyVersionRow {
  version: number;
  name: string;
  status: "draft" | "active" | "retired" | "discarded";
  proposed_by: string;
  approved_by: string | null;
  created_at: string;
  published_at: string | null;
  reason: string | null;
}

export interface WhatIfView {
  current_version: number;
  proposed_version: number;
  cases: number;
  changed: number;
  new_false_closes: number;
  less_cautious: number;
  errors: number;
  autonomy?: {
    level: 1;
    cases: number;
    auto_closed: number;
    qa_sample: number;
    human_review: number;
    false_closes: number;
    cap: number;
    qa_rate: number;
  };
}

export interface PolicyAuditEntry {
  ts: string;
  actor: string;
  action: string;
  version: number;
  detail?: string;
}

/** An earlier decision whose listed entry changed or was removed (POST /list-change/replay). */
export interface ListChangeCaseView {
  disposition_id: string;
  customer_id: string;
  entry_id: string;
  entry_name: string | null;
  earlier_decision: Decision;
  reason_code: "ENTRY_CHANGED" | "ENTRY_DELISTED";
  earlier_hash: string;
  current_hash?: string;
  earlier_snapshot_id: string | null;
  current_snapshot_id?: string;
  open_alert_ids: string[];
}

export interface ListChangeView {
  total: number;
  examined: number;
  complete: boolean;
  reopen: ListChangeCaseView[];
  release: ListChangeCaseView[];
  unchanged: number;
  impact: { customers: number; pending_payments: number; summary: string };
  policy_version: number;
  trace_id: string;
}

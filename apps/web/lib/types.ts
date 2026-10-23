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
  critic?: { rounds: number; final_verdict: string };
  record_hash?: string;
  approvals_required?: number;
  sample_mode?: boolean;
  sample_notice?: string;
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
  case: { alert_ref: string; record_id: string; run_id: string; decided_at: string };
  record: { hash: string; verified: boolean };
  definitions: Array<{ definition_id: string; version: string }>;
  data: {
    usl: { namespace: string; model_version: string };
    list_snapshots: Array<{ list_id: string; snapshot_id: string }>;
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
      cost: number;
    }>;
    data_queries: { count: number; total_latency_ms: number; rows_returned: number; cache_hits: number; cost: number };
    totals: { tokens_in: number; tokens_out: number; local_calls: number; cloud_calls: number; total_cost: number };
  };
}

export interface RecordView {
  decision: Decision;
  confidence: number;
  rationale: string;
  as_of: string;
  decided_at: string;
  policy: { version: number };
  definitions: Array<{ definition_id: string; version: string }>;
  list_snapshots: Array<{ list_id: string; snapshot_id: string }>;
  critic: { rounds: number; final_verdict: string };
  human: unknown[];
  record_hash: string;
}

export interface ExamMetrics {
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
  assumptions: { minutesPerAlert: number; minutesToConfirmClose: number };
}

export interface ExamAnswer {
  label: string;
  cases: number;
  results: ExamResult[];
  policy_version: number;
  headline?: Headline | null;
  headline_sentence?: string | null;
  headline_run?: string | null;
}

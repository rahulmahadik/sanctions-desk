import { z } from "zod";
import { hashValue, SHA256_HEX, sha256Hex } from "./hashing.js";
import { ListIdSchema, PolicyRefSchema, ThinkingSchema } from "./policy.js";
import { ReceiptSummarySchema } from "./receipts.js";
import { AgentNameSchema, AlertTypeSchema, DecisionSchema, RunIdSchema, RunResponseSchema } from "./schemas.js";

/**
 * Pointer memory (D3) and replayable decision records (D4).
 *
 * Memory never stores a copy of customer data. It stores a pointer to the source row plus a hash of
 * what the row contained, and re-reads the row through Zetaris when it is recalled. A changed hash
 * means the memory is stale and the case must be checked again.
 *
 * A decision record holds everything needed to answer "what did you know when you decided?" and
 * to re-run the decision as of that date. Records are sealed with a hash and never edited; a later
 * human action creates a new record that points back at the previous hash.
 */

const nonEmpty = z.string().min(1);
const unit = z.number().min(0).max(1);
const sha256 = z.string().regex(SHA256_HEX, "expected a 64 character lowercase SHA-256 hex digest");
const isoTime = z.iso.datetime();
const count = z.number().int().nonnegative();

// ---- memory pointers (D3) ------------------------------------------------------------------

export const MemoryPointerSchema = z.strictObject({
  /** Qualified USL table the row lives in. */
  usl_table: nonEmpty,
  /** Key columns that identify the row. Zetaris returns every value as a string. */
  row_key: z
    .record(z.string(), z.string())
    .refine((k) => Object.keys(k).length > 0, "row_key needs at least one column"),
  /** Hash of the row as it was read, see `hashRow`. */
  content_hash: sha256,
  /** Snapshot of the sanctions list the row came from, when it is a list entry. */
  list_snapshot_id: nonEmpty.optional(),
  usl_model_version: nonEmpty.optional(),
  captured_at: isoTime,
});
export type MemoryPointer = z.infer<typeof MemoryPointerSchema>;

/** Reason codes are fixed tokens, so a memory can explain a decision without holding personal data. */
export const ReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, "use UPPER_SNAKE_CASE reason codes");

/** What H-MEM keeps about a past decision: the outcome, why (as codes), and where to re-check it. */
export const DispositionMemorySchema = z.strictObject({
  memory_id: nonEmpty,
  alert_type: AlertTypeSchema,
  decision: DecisionSchema,
  reason_codes: z.array(ReasonCodeSchema).min(1),
  pointers: z.array(MemoryPointerSchema).min(1),
  policy: PolicyRefSchema,
  decision_record_hash: sha256,
  created_at: isoTime,
  superseded_by: nonEmpty.optional(),
});
export type DispositionMemory = z.infer<typeof DispositionMemorySchema>;

export const POINTER_STATES = ["fresh", "stale", "missing"] as const;
export type PointerState = (typeof POINTER_STATES)[number];

export interface CurrentRow {
  content_hash: string;
  list_snapshot_id?: string;
}

/**
 * Compare a pointer with the row as it is now. `undefined` means the row could not be found.
 * A memory may only influence a decision when every one of its pointers is fresh.
 */
export function checkPointer(pointer: MemoryPointer, current: CurrentRow | undefined): PointerState {
  if (!current) return "missing";
  if (current.content_hash !== pointer.content_hash) return "stale";
  if (
    pointer.list_snapshot_id !== undefined &&
    current.list_snapshot_id !== undefined &&
    current.list_snapshot_id !== pointer.list_snapshot_id
  ) {
    return "stale";
  }
  return "fresh";
}

export function memoryUsable(states: readonly PointerState[]): boolean {
  return states.length > 0 && states.every((s) => s === "fresh");
}

// ---- decision records (D4) -----------------------------------------------------------------

export const ListSnapshotRefSchema = z.strictObject({
  list: ListIdSchema,
  snapshot_id: nonEmpty,
  content_hash: sha256.optional(),
  published_at: isoTime.optional(),
});

export const QueryEvidenceSchema = z
  .strictObject({
    query_id: nonEmpty,
    agent: AgentNameSchema,
    /** Zetaris role the query ran under; it decided which columns were visible. */
    role: nonEmpty,
    table: nonEmpty,
    sql: nonEmpty,
    sql_hash: sha256,
    row_count: count,
    row_hashes: z.array(sha256),
    masked_columns: z.array(nonEmpty).default([]),
    /** Whether the query ran under the role's own token or the labelled fallback key. */
    token_source: z.enum(["role", "fallback"]).optional(),
    latency_ms: z.number().nonnegative().optional(),
    /** True when the answer came from the saved sample cache instead of a live query. */
    cache_hit: z.boolean().optional(),
  })
  .refine((q) => sha256Hex(q.sql) === q.sql_hash, { message: "sql_hash does not match sql", path: ["sql_hash"] });

export type QueryEvidenceInput = z.input<typeof QueryEvidenceSchema>;

export const MemoryUseSchema = z.strictObject({
  memory_id: nonEmpty,
  pointer_states: z.array(z.enum(POINTER_STATES)).min(1),
  used: z.boolean(),
});

export const ModelUseSchema = z.strictObject({
  agent: AgentNameSchema,
  model_requested: nonEmpty,
  model_routed: nonEmpty,
  provider: nonEmpty,
  route_kind: z.enum(["local", "cloud"]).nullable(),
  thinking: ThinkingSchema.optional(),
  tokens_in: count.optional(),
  tokens_out: count.optional(),
  latency_ms: z.number().nonnegative().optional(),
  /** The mode the runtime reports it served, when it differs from the one requested. */
  served_mode: nonEmpty.optional(),
  /** Signed receipt for this call; the full envelope is stored beside the trace. */
  receipt: ReceiptSummarySchema.optional(),
});

export type MemoryUseInput = z.input<typeof MemoryUseSchema>;
export type ModelUseInput = z.input<typeof ModelUseSchema>;

export const GuardVerdictSchema = z.strictObject({
  guard: nonEmpty,
  verdict: z.enum(["pass", "flag", "block"]),
  detail: z.string().optional(),
});

export type GuardVerdictInput = z.input<typeof GuardVerdictSchema>;

export const HumanActionSchema = z.strictObject({
  action: z.enum(["approve", "override", "second_approval", "reject"]),
  actor: nonEmpty,
  /** The actor's role when they acted. */
  role: z.enum(["analyst", "approver", "policy_admin", "viewer"]).optional(),
  at: isoTime,
  reason: z.string().optional(),
  /** The outcome the person settled on: the recommendation for an approval, their own choice for an override. */
  outcome: DecisionSchema.optional(),
});
export type HumanAction = z.infer<typeof HumanActionSchema>;

export const DECISION_RECORD_VERSION = 1 as const;

const DecisionRecordBody = z.strictObject({
  schema_version: z.literal(DECISION_RECORD_VERSION),
  record_id: RunIdSchema,
  run_id: RunIdSchema,
  alert_type: AlertTypeSchema,
  alert_ref: nonEmpty,
  decided_at: isoTime,
  /** The point in time whose data and policy the decision used. */
  as_of: isoTime,
  decision: DecisionSchema,
  confidence: unit,
  confidence_cap: z.strictObject({ value: unit, reason: nonEmpty }).optional(),
  rationale: z.string(),
  what_would_change: z.array(z.string()).default([]),
  policy: PolicyRefSchema,
  /** The business definitions applied, by id and version. */
  definitions: z
    .array(z.strictObject({ definition_id: nonEmpty, version: nonEmpty, statement_hash: sha256.optional() }))
    .default([]),
  usl: z.strictObject({ namespace: nonEmpty, model_version: nonEmpty }),
  list_snapshots: z.array(ListSnapshotRefSchema),
  queries: z.array(QueryEvidenceSchema),
  memories: z.array(MemoryUseSchema),
  models: z.array(ModelUseSchema),
  guards: z.array(GuardVerdictSchema),
  critic: z.strictObject({
    rounds: z.number().int().min(0).max(3),
    final_verdict: z.enum(["approved", "rejected", "escalated", "not_run"]),
  }),
  human: z.array(HumanActionSchema).default([]),
  /** Hash of the record this one supersedes (for example after a human action). */
  previous_record_hash: sha256.optional(),
});

export const DecisionRecordSchema = DecisionRecordBody.extend({ record_hash: sha256 });
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** Everything a caller supplies; the schema version and the hash are added when sealing. */
export type UnsealedDecisionRecord = Omit<z.input<typeof DecisionRecordBody>, "schema_version">;

/** Validate a record body and add its hash. The result is the immutable form. */
export function sealDecisionRecord(unsealed: UnsealedDecisionRecord): DecisionRecord {
  const body = DecisionRecordBody.parse({ ...unsealed, schema_version: DECISION_RECORD_VERSION });
  return DecisionRecordSchema.parse({ ...body, record_hash: hashValue(body) });
}

/** True when the record is valid and its hash matches its content. */
export function verifyDecisionRecord(record: unknown): record is DecisionRecord {
  const parsed = DecisionRecordSchema.safeParse(record);
  if (!parsed.success) return false;
  const { record_hash, ...body } = parsed.data;
  return hashValue(body) === record_hash;
}

/** Append a human action. The original stays untouched; the new record points back at its hash. */
export function appendHumanAction(record: DecisionRecord, action: HumanAction, recordId: string): DecisionRecord {
  const { record_hash, ...body } = record;
  return sealDecisionRecord({
    ...body,
    record_id: recordId,
    human: [...record.human, HumanActionSchema.parse(action)],
    previous_record_hash: record_hash,
  });
}

// ---- replay "as of" ------------------------------------------------------------------------

export const ReplayRequestSchema = z.strictObject({
  record_id: RunIdSchema,
  /** Re-run with the data and policy of this moment; defaults to the record's own `as_of`. */
  as_of: isoTime.optional(),
});
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

export interface ReplayDifference {
  field: string;
  recorded: unknown;
  replayed: unknown;
}

export interface ReplayReport {
  record_id: string;
  as_of: string;
  reproduced: boolean;
  differences: ReplayDifference[];
  replayed_record_hash?: string;
}

/**
 * Compare a recorded decision with its replay. Timing, model routes and token counts are ignored on
 * purpose: they differ between runs. What must match is the outcome and the facts it rested on.
 */
export function compareDecisionRecords(recorded: DecisionRecord, replayed: DecisionRecord): ReplayDifference[] {
  const facts = (r: DecisionRecord) => ({
    decision: r.decision,
    confidence: r.confidence,
    policy: r.policy,
    usl: r.usl,
    list_snapshots: r.list_snapshots,
    query_rows: r.queries.map((q) => ({ table: q.table, sql_hash: q.sql_hash, row_hashes: [...q.row_hashes].sort() })),
    memories: r.memories.map((m) => ({ memory_id: m.memory_id, used: m.used, states: m.pointer_states })),
    guards: r.guards,
  });
  const a = facts(recorded);
  const b = facts(replayed);
  return (Object.keys(a) as Array<keyof typeof a>)
    .filter((field) => hashValue(a[field]) !== hashValue(b[field]))
    .map((field) => ({ field, recorded: a[field], replayed: b[field] }));
}

// ---- the answer to POST /run ---------------------------------------------------------------

const RunCitationSchema = z.strictObject({
  source: z.literal("zetaris"),
  query_id: nonEmpty,
  table: nonEmpty,
  row_keys: z.array(z.string()),
});

/**
 * The structured answer to a review. It extends the base run response with the evidence trail:
 * which models answered (with signed receipts), what the guards decided, the critic's verdict and the
 * hash of the sealed decision record. A recommendation always needs a human to act on it.
 */
export const ReviewResponseSchema = RunResponseSchema.extend({
  /** The two or three lines of evidence that decided the case, for the reviewer to read first. */
  key_evidence: z.array(z.string()).max(3).default([]),
  /** Set when the confidence was capped, with the reason (for example a failing data-quality rule). */
  confidence_cap: z.strictObject({ value: z.number(), reason: z.string() }).optional(),
  citations: z.array(RunCitationSchema).default([]),
  models: z.array(ModelUseSchema).default([]),
  guards: z.array(GuardVerdictSchema).default([]),
  critic: z
    .strictObject({
      rounds: z.number().int().min(0).max(3),
      final_verdict: z.enum(["approved", "rejected", "escalated", "not_run"]),
    })
    .optional(),
  record_id: nonEmpty.optional(),
  record_hash: sha256.optional(),
  /** Always true: the desk recommends, a person decides. RECOMMEND_BLOCK needs two approvals. */
  human_review_required: z.literal(true).optional(),
  approvals_required: z.number().int().min(1).optional(),
  sample_mode: z.boolean().optional(),
  sample_notice: z.string().optional(),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

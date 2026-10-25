import { z } from "zod";
import { hashValue, SHA256_HEX, sha256Hex } from "./hashing.js";
import { ListIdSchema, PolicyRefSchema, ThinkingSchema } from "./policy.js";
import { ReceiptSummarySchema } from "./receipts.js";
import { AgentNameSchema, AlertTypeSchema, DecisionSchema, RunIdSchema, RunResponseSchema } from "./schemas.js";

/**
 * Pointer memory and replayable decision records.
 *
 * Memory never stores a copy of customer data. It stores a pointer to the source row plus a hash of
 * what the row contained, and re-reads the row through Zetaris when it is recalled. A changed hash
 * means the memory is stale and the case must be checked again.
 *
 * A decision record holds everything needed to answer "what did you know when you decided?". Records are sealed with a
 * hash and never edited; a later human action creates a new record that points back at the previous hash.
 */

const nonEmpty = z.string().min(1);
const unit = z.number().min(0).max(1);
const sha256 = z.string().regex(SHA256_HEX, "expected a 64 character lowercase SHA-256 hex digest");
const isoTime = z.iso.datetime();
const count = z.number().int().nonnegative();

// ---- memory pointers ------------------------------------------------------------------------

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

// ---- decision records -----------------------------------------------------------------------

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
    /**
     * True when `sql` is the statement with a value replaced by a marker (a document number, as
     * `'<document number, sha256 …>'`); `sql_hash` is the hash of that kept form, not of what Zetaris ran.
     */
    redacted: z.literal(true).optional(),
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
  /** The Nightshift app identity the call was sent under (reasoning or guard), which the cockpit may bind. */
  app: nonEmpty.optional(),
  thinking: ThinkingSchema.optional(),
  tokens_in: count.optional(),
  tokens_out: count.optional(),
  latency_ms: z.number().nonnegative().optional(),
  /** The mode the runtime reports it served, when it differs from the one requested. */
  served_mode: nonEmpty.optional(),
  /** Signed receipt for this call; the full envelope is stored beside the trace. */
  receipt: ReceiptSummarySchema.optional(),
  /** Set when the answer was not used because its Nightshift receipt was missing or not signed by the pinned key. */
  receipt_rejected: nonEmpty.optional(),
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
  action: z.enum(["approve", "override", "second_approval", "reject", "reopen"]),
  actor: nonEmpty,
  /** The actor's role when they acted. */
  role: z.enum(["analyst", "approver", "policy_admin", "viewer"]).optional(),
  at: isoTime,
  reason: z.string().optional(),
  /** The outcome the person settled on: the recommendation for an approval, their own choice for an override. */
  outcome: DecisionSchema.optional(),
});
export type HumanAction = z.infer<typeof HumanActionSchema>;

export const AutonomyRecordSchema = z.strictObject({
  /** The level the policy asked for and the level in force (0 when the kill switch is on). */
  policy_level: z.union([z.literal(0), z.literal(1)]),
  level_in_force: z.union([z.literal(0), z.literal(1)]),
  outcome: z.enum(["human_review", "auto_closed", "qa_sample"]),
  conditions: z.array(z.strictObject({ name: nonEmpty, met: z.boolean(), detail: z.string().optional() })),
  /** The random draw used for the quality-assurance sample, and the rate it was compared with. */
  qa_draw: z.number().min(0).max(1),
  qa_rate: z.number().min(0).max(1),
  /** For an automatic close: "closed automatically under policy vX, level 1, conditions met: ...". */
  statement: z.string().optional(),
});
export type AutonomyRecord = z.infer<typeof AutonomyRecordSchema>;

/** A value taken from a note that carries a check reference, a document number and a date. */
export const DocumentaryValueSchema = z.strictObject({
  field: z.literal("date_of_birth"),
  value: nonEmpty,
  source: nonEmpty,
  check_reference: nonEmpty,
  /** How it is shown to a reviewer: never as a value of the customer record. */
  label: nonEmpty,
});
export type DocumentaryValue = z.infer<typeof DocumentaryValueSchema>;

const SpanSchema = z.strictObject({ start: count, end: count });

/**
 * Whether the document number a documentary note cites is one of the customer's documents. The count is worked out by a
 * query inside Zetaris; the record keeps the outcome, a hash of the normalised number and the query id, never the number.
 */
export const NoteDocumentCheckSchema = z.strictObject({
  status: z.enum(["on_record", "not_on_record", "not_verified"]),
  /** Plain words for the reviewer, for every status but "on_record". */
  reason: nonEmpty.optional(),
  number_hash: sha256,
  query_id: nonEmpty.optional(),
});
export type NoteDocumentCheck = z.infer<typeof NoteDocumentCheckSchema>;

/** A citation the critic set aside because the source cannot be cited at all (not a value that failed to hold). */
export const NotCitableSchema = z.strictObject({
  table: nonEmpty,
  column: nonEmpty,
  reason: nonEmpty,
  round: z.number().int().min(1).max(3),
});
export type NotCitable = z.infer<typeof NotCitableSchema>;

/**
 * What the screener found in the free text of the case, as structured facts. Nothing here is the text itself: a span is
 * a field and a character range, and every value was checked by code against the text it came from.
 */
export const ScreenerRecordSchema = z.strictObject({
  status: z.enum(["ok", "nothing_to_read", "failed", "off"]),
  /** Why it failed, when it did: the model service, or an answer that could not be used. */
  failure: z.enum(["provider", "parsing", "withheld"]).optional(),
  /** True when the answer used came from a cloud route, so the text did leave the machine. */
  served_by_cloud: z.boolean().optional(),
  truncated_fields: z.array(nonEmpty).optional(),
  fields_read: z.array(nonEmpty),
  signals: z.array(
    z.strictObject({
      type: nonEmpty,
      confidence: unit,
      span_id: nonEmpty,
      /** False when the span the model named does not point into the field. */
      span_valid: z.boolean(),
      /**
       * False when the span's text holds no term of the signal's type or no name from the evidence near it: the signal
       * is kept and shown, and still blocks a close. Optional: records made before policy version 7 do not have it.
       */
      grounded: z.boolean().optional(),
      grounding_reason: nonEmpty.optional(),
    }),
  ),
  documentary: z.array(
    z.strictObject({
      field: nonEmpty,
      meets_standard: z.boolean(),
      missing: z.array(nonEmpty),
      /** Where in the field the check reference and the date were found: start inclusive, end exclusive. */
      check_reference_span: SpanSchema.optional(),
      date_span: SpanSchema.optional(),
      /** The note's document number compared with the customer's documents inside Zetaris. Never the number. */
      document_check: NoteDocumentCheckSchema.optional(),
    }),
  ),
  injection: z.boolean(),
  model: nonEmpty.optional(),
  receipt_id: nonEmpty.optional(),
});
export type ScreenerRecord = z.infer<typeof ScreenerRecordSchema>;

/** What one model-bound step was sent: field names and counts, and a hash of the whole payload. Never the text. */
export const CloudPayloadSchema = z.strictObject({
  step: nonEmpty,
  prompt_hash: sha256,
  prompt_chars: count,
  /** Top-level names in the evidence block and how many items each holds (1 for a single value). */
  fields: z.record(z.string(), count),
  /** True when a customer note, payment reference or list remark appears in the payload. It must never be true. */
  raw_free_text_present: z.boolean(),
});
export type CloudPayload = z.infer<typeof CloudPayloadSchema>;

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
    /** Citations set aside from the second round on because their source cannot be cited at all. */
    not_citable: z.array(NotCitableSchema).optional(),
  }),
  /** The hybrid: what code concluded from the structured fields, and the path the review took because of it. */
  first_finding: DecisionSchema.optional(),
  review_path: z.enum(["confirm", "reason"]).optional(),
  autonomy: AutonomyRecordSchema.optional(),
  documentary: z.array(DocumentaryValueSchema).optional(),
  screener: ScreenerRecordSchema.optional(),
  cloud_payloads: z.array(CloudPayloadSchema).optional(),
  /** Cloud privacy mode: the tokens the cloud steps saw instead of the case's values. Absent when the mode is off. */
  privacy: z
    .strictObject({
      mode: z.literal("pseudonymise"),
      tokens: z.array(
        z.strictObject({
          token: nonEmpty,
          kind: z.enum(["party", "listed", "document", "dob", "country", "address"]),
          value: nonEmpty,
        }),
      ),
    })
    .optional(),
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
  /** The path the review took: code settled it and the agents confirmed, or the agents reasoned over free text. */
  path: z.enum(["confirm", "reason"]).optional(),
  /** What code alone concluded from the structured fields. */
  first_finding: DecisionSchema.optional(),
  /** Set when the confidence was capped, with the reason (for example a failing data-quality rule). */
  confidence_cap: z.strictObject({ value: z.number(), reason: z.string() }).optional(),
  citations: z.array(RunCitationSchema).default([]),
  models: z.array(ModelUseSchema).default([]),
  guards: z.array(GuardVerdictSchema).default([]),
  critic: z
    .strictObject({
      rounds: z.number().int().min(0).max(3),
      final_verdict: z.enum(["approved", "rejected", "escalated", "not_run"]),
      not_citable: z.array(NotCitableSchema).optional(),
    })
    .optional(),
  record_id: nonEmpty.optional(),
  record_hash: sha256.optional(),
  /** True unless the autonomy setting closed the case automatically (a person can reopen it). RECOMMEND_BLOCK needs two approvals. */
  human_review_required: z.boolean().optional(),
  /** What the autonomy setting did with the recommendation; absent at level 0. */
  autonomy: AutonomyRecordSchema.optional(),
  /** Values taken from verified notes and shown as such. */
  documentary: z.array(DocumentaryValueSchema).optional(),
  approvals_required: z.number().int().min(1).optional(),
  /** The model that gave the recommendation used, and which try it was: the own lane, the fast retry, the backup. */
  decision_model: nonEmpty.optional(),
  decision_route: z.enum(["own", "fast", "backup"]).optional(),
  /** True when the recommendation came from a fallback (a retry lane, the backup provider, the rules stand-in) or none came. */
  decided_by_fallback: z.boolean().optional(),
  /** The decision model's own last recommendation, before the challenger and the policy guard. */
  model_last_recommendation: DecisionSchema.optional(),
  /** True when the critic could not approve within the allowed rounds. */
  critic_unresolved: z.boolean().optional(),
  sample_mode: z.boolean().optional(),
  sample_notice: z.string().optional(),
  /** Set when the review could not run and the alert is held for a person, with why (no record is sealed then). */
  held_reason: z.enum(["data_service_unavailable"]).optional(),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

import { z } from "zod";
import { ReceiptSummarySchema } from "./receipts.js";

export const DecisionSchema = z.enum(["CLOSE_FALSE_POSITIVE", "ESCALATE_L2", "RECOMMEND_BLOCK", "NEED_MORE_INFO"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const AgentNameSchema = z.enum([
  "system",
  "triage",
  "evidence",
  "matching",
  "ownership",
  "memory",
  "decision",
  "critic",
  "policy_guard",
  "reporter",
  "human",
]);
export type AgentName = z.infer<typeof AgentNameSchema>;

/** What kind of screening alert a run reviews. */
export const AlertTypeSchema = z.enum(["customer", "payment"]);
export type AlertType = z.infer<typeof AlertTypeSchema>;

/** run ids end up in file names, so they are restricted to a safe alphabet. */
export const RunIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "run_id may only contain letters, digits, dot, underscore and dash")
  .refine((s) => !s.includes(".."), "run_id must not contain '..'");

export const PolicyVersionSchema = z.number().int().positive();

export const RunRequestSchema = z
  .object({
    run_id: RunIdSchema.optional(),
    alert_type: AlertTypeSchema.default("customer"),
    alert_id: z.string().min(1).max(100).optional(),
    alert: z.record(z.string(), z.unknown()).optional(),
    options: z.object({ sample_mode: z.boolean().optional() }).default({}),
  })
  .refine((v) => v.alert_id !== undefined || v.alert !== undefined, {
    message: "either alert_id or alert is required",
  });
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const CitationSchema = z.object({
  source: z.literal("zetaris"),
  query_id: z.string(),
  table: z.string().optional(),
  row_keys: z.array(z.string()).default([]),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ErrorBodySchema = z.object({
  type: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const RunResponseSchema = z.object({
  run_id: z.string(),
  status: z.enum(["ok", "error"]),
  alert_type: AlertTypeSchema.optional(),
  /** The policy version this run was pinned to. Decisions are only comparable within a version. */
  policy_version: PolicyVersionSchema.optional(),
  decision: DecisionSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
  what_would_change: z.array(z.string()).default([]),
  citations: z.array(CitationSchema).default([]),
  agents: z.array(z.string()).default([]),
  trace_id: z.string(),
  log_file: z.string().optional(),
  execution_time_seconds: z.number().nonnegative(),
  error: ErrorBodySchema.optional(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const TraceStatusSchema = z.enum(["ok", "error", "retry", "blocked", "skipped"]);

/**
 * One run event. The same object is written as a line of logs/trace-<run_id>.jsonl and published on
 * the run event bus (the live view and the replay scrubber read it from there).
 */
export const TraceEventSchema = z.object({
  ts: z.string(),
  run_id: z.string(),
  seq: z.number().int().nonnegative(),
  agent: AgentNameSchema,
  action: z.string().min(1),
  status: TraceStatusSchema,
  input_summary: z.string().optional(),
  output_summary: z.string().optional(),
  target_agent: AgentNameSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  retry_count: z.number().int().nonnegative().optional(),
  policy_version: PolicyVersionSchema.optional(),
  provider: z.string().optional(),
  model_requested: z.string().optional(),
  model_used: z.string().optional(),
  route_kind: z.enum(["local", "cloud"]).nullable().optional(),
  latency_ms: z.number().nonnegative().optional(),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  zetaris_query_id: z.string().optional(),
  /** Signed Nightshift receipt for the model call this event describes (compact form). */
  receipt: ReceiptSummarySchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type TraceEventInput = Omit<z.input<typeof TraceEventSchema>, "ts" | "run_id" | "seq">;
/** A run event is exactly a trace event. */
export type RunEvent = TraceEvent;

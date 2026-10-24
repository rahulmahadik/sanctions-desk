import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from "@sanctions-desk/agents";
import { PolicySchema, ReviewResponseSchema, RunIdSchema, RunRequestSchema } from "@sanctions-desk/shared";
import { z } from "zod";
import { SAFE_ID_PATTERN } from "./ids.js";

/**
 * The OpenAPI description of the API. The request and response shapes are generated from the same zod schemas the
 * routes validate with; each route is listed once below with a plain-English summary, and a test fails when a route
 * is registered that this list does not describe.
 */

type Json = Record<string, unknown>;

const schemaOf = (schema: z.ZodType): Json => {
  try {
    return z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "input" }) as Json;
  } catch {
    return { type: "object" };
  }
};

const ErrorBody: Json = {
  type: "object",
  properties: {
    status: { const: "error" },
    request_id: { type: "string" },
    error: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "validation, not_found, guard_blocked, query_failed, bad_response, rate_limited, ...",
        },
        message: { type: "string" },
        recoverable: { type: "boolean" },
      },
      required: ["type", "message", "recoverable"],
    },
  },
  required: ["status", "request_id", "error"],
};

const obj = (properties: Json = {}, required: string[] = []): Json => ({ type: "object", properties, required });
// The id parameters carry the same pattern and lengths the routes validate with, never a copy of them.
const AlertIdParam = {
  name: "alertId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: SAFE_ID_PATTERN.source },
};
const RunIdParam = { name: "runId", in: "path", required: true, schema: schemaOf(RunIdSchema) };
const VersionParam = { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } };

interface RouteDoc {
  method: "get" | "post";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  params?: Json[];
  query?: Json[];
  body?: Json;
  response?: Json;
  stream?: boolean;
}

const PERSON = { type: "string", minLength: 1, maxLength: 100 };
/** The reason a person gives with a decision: the human decision step's one rule, as the routes enforce it. */
const REASON = { type: "string", minLength: MIN_REASON_LENGTH, maxLength: MAX_REASON_LENGTH };

export const ROUTES: RouteDoc[] = [
  {
    method: "get",
    path: "/health",
    tag: "System",
    summary: "Liveness",
    response: obj({ status: { type: "string" }, sample_mode: { type: "boolean" } }),
  },
  {
    method: "get",
    path: "/health/dependencies",
    tag: "System",
    summary: "Readiness of Nightshift, Ollama and Zetaris",
  },
  {
    method: "get",
    path: "/alerts",
    tag: "Review",
    summary: "The alert queue, read through the semantic layer, with the latest recommendation of each alert",
  },
  {
    method: "post",
    path: "/run",
    tag: "Review",
    summary: "Review one alert and return a recommendation for a person to act on",
    description:
      "Identify the alert by alert_id. The answer carries the recommendation (decision, confidence), rationale, cited facts, the checks that ran, the model ledger and the record hash, plus the steps that ran in order (agents), the trace id and the trace file (trace_id, log_file: logs/trace-<run_id>.jsonl), the time taken (execution_time_seconds) and, in sample mode, sample_mode and sample_notice. A failure has status error and a structured error. Pass a run_id of your own to follow the run on /runs/{runId}/stream while it works. `npm run case -- <request file>` runs the same route from the command line.",
    body: schemaOf(RunRequestSchema),
    response: schemaOf(ReviewResponseSchema),
  },
  {
    method: "get",
    path: "/runs/{runId}/events",
    tag: "Review",
    summary: "The recorded events of a run",
    params: [RunIdParam],
  },
  {
    method: "get",
    path: "/runs/{runId}/stream",
    tag: "Review",
    summary: "A run's events as server-sent events, live and then recorded",
    params: [RunIdParam],
    stream: true,
  },
  {
    method: "get",
    path: "/runs/{runId}/trace",
    tag: "Review",
    summary: "The decision trace of a run's recommendation",
    params: [RunIdParam],
  },
  {
    method: "get",
    path: "/cases/{alertId}/record",
    tag: "Review",
    summary: "The sealed decision record of the latest recommendation for an alert",
    params: [AlertIdParam],
  },
  {
    method: "get",
    path: "/cases/{alertId}/evidence",
    tag: "Review",
    summary: "The facts a case rests on, read through the evidence role (identifier numbers masked)",
    params: [AlertIdParam],
  },
  {
    method: "get",
    path: "/cases/{alertId}/trace",
    tag: "Review",
    summary: "The four-question decision trace: definitions, data, access and cost",
    params: [AlertIdParam],
    query: [
      {
        name: "audit",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["true"] },
        description: "Also match each query with Zetaris's own statement history",
      },
    ],
  },
  {
    method: "get",
    path: "/me",
    tag: "People",
    summary: "Who you are, what you may do, and the demo users in sample mode",
  },
  {
    method: "get",
    path: "/cases/{alertId}/human",
    tag: "People",
    summary: "Where a recommendation stands after people acted on it, and the records prepared from their decision",
    params: [AlertIdParam],
  },
  {
    method: "get",
    path: "/cases/{alertId}/actions",
    tag: "People",
    summary:
      "The records prepared after an approval (closure note, ticket, draft, hold instruction), with their seal check",
    params: [AlertIdParam],
  },
  {
    method: "post",
    path: "/cases/{alertId}/decision",
    tag: "People",
    summary: "Approve or override a recommendation, with a reason. A block still needs a second approval",
    params: [AlertIdParam],
    body: obj(
      {
        action: { type: "string", enum: ["approve", "override"] },
        outcome: {
          type: "string",
          enum: ["CLOSE_FALSE_POSITIVE", "ESCALATE_L2", "RECOMMEND_BLOCK", "NEED_MORE_INFO"],
          description: "Required for an override",
        },
        reason: REASON,
        record_hash: { type: "string", description: "The hash of the recommendation you were looking at" },
      },
      ["action", "reason", "record_hash"],
    ),
  },
  {
    method: "post",
    path: "/cases/{alertId}/second-approval",
    tag: "People",
    summary: "The second approver confirms or declines a block. Must be an approver and a different person",
    params: [AlertIdParam],
    body: obj(
      {
        approve: { type: "boolean" },
        reason: REASON,
        record_hash: { type: "string" },
      },
      ["approve", "reason", "record_hash"],
    ),
  },
  {
    method: "post",
    path: "/cases/{alertId}/reopen",
    tag: "People",
    summary: "Reopen a close the desk made automatically; the case then waits for a person's decision",
    params: [AlertIdParam],
    body: obj({ reason: REASON, record_hash: { type: "string" } }, ["reason", "record_hash"]),
  },
  {
    method: "get",
    path: "/autonomy",
    tag: "People",
    summary: "The autonomy level in force, today's automatic closes against the cap, and the kill switch",
  },
  {
    method: "post",
    path: "/autonomy/kill-switch",
    tag: "People",
    summary: "Force autonomy level 0 at once (an approver or policy admin); only a policy admin can switch it back on",
    body: obj({ active: { type: "boolean" }, reason: REASON }, ["active", "reason"]),
  },
  {
    method: "get",
    path: "/auto-closed",
    tag: "People",
    summary: "Closes made automatically, for a person to review and reopen",
  },
  {
    method: "get",
    path: "/cases/{alertId}/file",
    tag: "People",
    summary:
      "The case file as Markdown or PDF: recommendation, facts, what people did, what was prepared next, models and the record hash",
    params: [AlertIdParam],
    query: [
      {
        name: "format",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["md", "pdf"] },
        description: "md (default) or pdf",
      },
    ],
  },
  {
    method: "get",
    path: "/receipts/{receiptId}/verify",
    tag: "Review",
    summary:
      "Check a stored signed receipt: the signature, whether the key is pinned, the app, the modes and the model that served the call",
    params: [
      {
        name: "receiptId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "The receipt id from the model ledger",
      },
    ],
  },
  {
    method: "post",
    path: "/list-change/replay",
    tag: "Review",
    summary: "Check every earlier decision against the list as it is now",
    body: obj({ batch_size: { type: "integer" }, max_batches: { type: "integer" }, cursor: { type: "integer" } }),
  },
  {
    method: "post",
    path: "/guard/outbound",
    tag: "Review",
    summary: "Check a draft message for a customer; refuses anything that reveals screening or an investigation",
    body: obj({ text: { type: "string", minLength: 1, maxLength: 5000 } }, ["text"]),
  },
  {
    method: "get",
    path: "/exam",
    tag: "Evaluation",
    summary: "The saved exam results, the headline measure and the measured routing split",
  },
  {
    method: "get",
    path: "/governance",
    tag: "Governance",
    summary:
      "The governance view: inventory, risk materiality, oversight, testing, monitoring, change control and limits",
  },
  { method: "get", path: "/policy", tag: "Policy", summary: "The active policy" },
  { method: "get", path: "/policy/versions", tag: "Policy", summary: "Every policy version and its status" },
  {
    method: "get",
    path: "/policy/versions/{version}",
    tag: "Policy",
    summary: "One policy version",
    params: [VersionParam],
  },
  { method: "get", path: "/policy/audit", tag: "Policy", summary: "The audit log of policy changes" },
  {
    method: "post",
    path: "/policy/drafts",
    tag: "Policy",
    summary: "Propose a policy change as a draft",
    description:
      "Validated against the policy schema, which fixes the hard limits: no automatic block, no customer messages, read-only data.",
    body: obj({ policy: schemaOf(PolicySchema), proposed_by: PERSON, reason: { type: "string", maxLength: 500 } }, [
      "policy",
      "proposed_by",
    ]),
  },
  {
    method: "post",
    path: "/policy/reload",
    tag: "Policy",
    summary: "Propose the policy file as a draft",
    body: obj({ proposed_by: PERSON, reason: { type: "string" } }, ["proposed_by"]),
  },
  {
    method: "post",
    path: "/policy/rollback",
    tag: "Policy",
    summary: "Propose an earlier version as a new draft",
    body: obj({ to_version: { type: "integer", minimum: 1 }, proposed_by: PERSON }, ["to_version", "proposed_by"]),
  },
  {
    method: "post",
    path: "/policy/drafts/{version}/publish",
    tag: "Policy",
    summary: "Publish a draft; the approver must differ from the proposer (four-eyes)",
    params: [VersionParam],
    body: obj({ approved_by: PERSON }, ["approved_by"]),
  },
  {
    method: "post",
    path: "/policy/drafts/{version}/discard",
    tag: "Policy",
    summary: "Discard a draft",
    params: [VersionParam],
    body: obj({ actor: PERSON }, ["actor"]),
  },
  {
    method: "post",
    path: "/policy/whatif",
    tag: "Policy",
    summary: "Review exam cases under the active policy and under a draft, and list what changes. Saves nothing",
    body: obj(
      {
        version: { type: "integer", minimum: 1 },
        cases: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["version"],
    ),
  },
];

/** The OpenAPI 3.1 document. */
export function buildOpenApi(version: string, extra: RouteDoc[] = []): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of [...ROUTES, ...extra]) {
    paths[r.path] = paths[r.path] ?? {};
    (paths[r.path] as Record<string, Json>)[r.method] = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      parameters: [...(r.params ?? []), ...(r.query ?? [])],
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: r.body } } } } : {}),
      responses: {
        "200": r.stream
          ? {
              description: "A stream of server-sent events",
              content: { "text/event-stream": { schema: { type: "string" } } },
            }
          : { description: "OK", content: { "application/json": { schema: r.response ?? { type: "object" } } } },
        "400": { description: "The request is not valid", content: { "application/json": { schema: ErrorBody } } },
        "404": { description: "Not found", content: { "application/json": { schema: ErrorBody } } },
        ...(r.method === "post"
          ? {
              "429": {
                description: "Too many requests from this caller, or too many reviews running; see Retry-After",
                headers: { "Retry-After": { schema: { type: "integer", minimum: 1 } } },
                content: { "application/json": { schema: ErrorBody } },
              },
            }
          : {}),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Sanctions Desk API",
      version,
      description:
        "A review desk for sanctions-screening alerts. The desk recommends; a person makes the final call (automatic closing is off by default). Nothing here blocks an account, writes to a source system or contacts a customer.",
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: "http://localhost:8000" }],
    paths,
  };
}

import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from "@sanctions-desk/agents";
import { PERMISSIONS, PolicySchema, ReviewResponseSchema, RunIdSchema, RunRequestSchema } from "@sanctions-desk/shared";
import { z } from "zod";
import { permissionFor } from "./access.js";
import { AUTH_GUIDE } from "./auth-guide.js";
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

/** Routes anyone may call, signed in or not. */
const PUBLIC = new Set(["/health"]);

/**
 * Rules a route's handler adds on top of the role it needs (the routes and human-decision.ts enforce these). The
 * four-eyes rules are here: a second, different person must confirm.
 */
const ACCESS_RULES: Record<string, string> = {
  "post /cases/{alertId}/decision":
    "An analyst or approver decides. Only an approver may override towards a less cautious outcome. Four-eyes: a block, and an override that lowers caution (a block or an escalation changed to a close), wait for a second, different approver.",
  "post /cases/{alertId}/second-approval":
    "Four-eyes: the second approval must come from an approver who is not the person who made the first decision.",
  "post /autonomy/kill-switch":
    "An approver or a policy admin can stop automatic closing; only a policy admin can switch it back on.",
  "post /policy/drafts/{version}/publish":
    "Four-eyes: the policy admin who publishes must not be the person who proposed the draft.",
};

/** Who may call a route, as the API enforces it (app.ts with access.ts), in words for the document. */
function accessOf(r: RouteDoc): { roles: string[] | "public" | "any"; text: string } {
  if (PUBLIC.has(r.path)) return { roles: "public", text: "Public: no token needed." };
  const need = permissionFor(r.method.toUpperCase(), r.path.replace(/\{(\w+)\}/g, ":$1"));
  const rule = ACCESS_RULES[`${r.method} ${r.path}`];
  if (need === undefined)
    return {
      roles: "any",
      text: `Any signed-in role (viewer, analyst, approver, policy_admin).${rule ? ` ${rule}` : ""}`,
    };
  const roles = [...PERMISSIONS[need]];
  return { roles, text: `Roles: ${roles.join(", ")}.${rule ? ` ${rule}` : ""}` };
}

const errorExample = (type: string, message: string) => ({
  status: "error",
  request_id: "3f1c2a9e-5d7b-4c1e-9a2f-0b6d8e4c7a11",
  error: { type, message, recoverable: type === "rate_limited" },
});

/** The OpenAPI 3.1 document. */
export function buildOpenApi(version: string, extra: RouteDoc[] = []): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of [...ROUTES, ...extra]) {
    paths[r.path] = paths[r.path] ?? {};
    const access = accessOf(r);
    (paths[r.path] as Record<string, Json>)[r.method] = {
      tags: [r.tag],
      summary: r.summary,
      description: [access.text, r.description].filter(Boolean).join("\n\n"),
      "x-required-roles": access.roles,
      ...(access.roles === "public" ? { security: [] } : {}),
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
        ...(access.roles === "public"
          ? {}
          : {
              "401": {
                description: "No token, or a token that is unknown, malformed, expired or revoked",
                content: {
                  "application/json": {
                    schema: ErrorBody,
                    example: errorExample("unauthorized", "a valid token is required"),
                  },
                },
              },
              ...(access.roles === "any"
                ? {}
                : {
                    "403": {
                      description: "Signed in, but this role may not do this",
                      content: {
                        "application/json": {
                          schema: ErrorBody,
                          example: errorExample("forbidden", "viewer may not do this"),
                        },
                      },
                    },
                  }),
            }),
        ...(r.method === "post"
          ? {
              "429": {
                description: "Too many requests from this caller, or too many reviews running; see Retry-After",
                headers: { "Retry-After": { schema: { type: "integer", minimum: 1 } } },
                content: {
                  "application/json": {
                    schema: ErrorBody,
                    example: errorExample("rate_limited", "too many requests (writes); try again in 42 s"),
                  },
                },
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
      description: `A review desk for sanctions-screening alerts. The desk recommends; a person makes the final call (automatic closing is off by default). Nothing here blocks an account, writes to a source system or contacts a customer.\n\n${AUTH_GUIDE}`,
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: "http://localhost:8000" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A token issued with `npm run users:add` (sd_ and 32 characters, 192 random bits). Send it as `Authorization: Bearer <token>`. Every route except /health needs one when sign-in is on.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

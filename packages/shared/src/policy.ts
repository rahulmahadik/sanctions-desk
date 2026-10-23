import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolveProjectPath } from "./config.js";
import { AppError } from "./errors.js";
import { hashValue } from "./hashing.js";
import { AgentModelIdSchema } from "./modes.js";
import { PolicyVersionSchema } from "./schemas.js";

/**
 * The policy is every tunable behaviour of the desk, as data. Code reads the active version once at
 * the start of a run and keeps it for that run. Fields that can never be relaxed (no auto-block, no
 * customer messages, read-only data) are literals here, so no policy document can switch them on.
 */

export const LIST_IDS = ["OFAC", "UN", "EU", "UK"] as const;
export const ListIdSchema = z.enum(LIST_IDS);
export type ListId = (typeof LIST_IDS)[number];

export const STRONG_IDENTIFIER_FIELDS = ["dob", "nationality", "id_number", "passport_number"] as const;
export const StrongIdentifierFieldSchema = z.enum(STRONG_IDENTIFIER_FIELDS);

export const JURISDICTION_ACTIONS = ["review", "escalate", "recommend_block"] as const;

const unit = z.number().min(0).max(1);
const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();
const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;

export const ThinkingSchema = z.union([
  z.literal("off"),
  z.literal("on"),
  z.strictObject({ budgetTokens: positiveInt }),
]);
export type Thinking = z.infer<typeof ThinkingSchema>;

/** `model` is a lane name (fast, deep, judge) or a pinned mode. meterless/auto is never allowed. */
export const AgentModelSchema = z.strictObject({
  model: AgentModelIdSchema,
  thinking: ThinkingSchema,
  timeoutMs: positiveInt.max(600_000),
});
export type AgentModel = z.infer<typeof AgentModelSchema>;

const perAgent = <T extends z.ZodType>(schema: T) =>
  z.strictObject({
    triage: schema,
    evidence: schema,
    matching: schema,
    ownership: schema,
    decision: schema,
    critic: schema,
    challenger: schema,
    policy_guard: schema,
    reporter: schema,
  });

const regexSource = nonEmpty.refine((s) => {
  try {
    new RegExp(s, "iu");
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

export const PolicySchema = z.strictObject({
  version: PolicyVersionSchema,
  name: nonEmpty,
  description: z.string().optional(),

  lists: z
    .strictObject({
      enabled: z.array(ListIdSchema).min(1),
      weights: z.strictObject({ OFAC: unit, UN: unit, EU: unit, UK: unit }),
    })
    .refine((l) => unique(l.enabled), { message: "enabled lists must be unique", path: ["enabled"] })
    .refine((l) => l.enabled.every((id) => l.weights[id] > 0), {
      message: "every enabled list needs a weight above 0",
      path: ["weights"],
    }),

  matching: z
    .strictObject({
      nameSimilarityThreshold: unit,
      /** Name similarity at or below this, with no other signal, is eligible to close. */
      autoCloseCeiling: unit,
      strongIdentifierFields: z.array(StrongIdentifierFieldSchema).min(1),
      minStrongIdentifierMatches: positiveInt,
    })
    .refine((m) => m.autoCloseCeiling <= m.nameSimilarityThreshold, {
      message: "autoCloseCeiling must not exceed nameSimilarityThreshold",
      path: ["autoCloseCeiling"],
    })
    .refine((m) => unique(m.strongIdentifierFields), {
      message: "strong identifier fields must be unique",
      path: ["strongIdentifierFields"],
    })
    .refine((m) => m.minStrongIdentifierMatches <= m.strongIdentifierFields.length, {
      message: "cannot require more strong matches than strong fields",
      path: ["minStrongIdentifierMatches"],
    }),

  ownership: z.strictObject({
    /** OFAC's 50 percent rule: ownership of this much or more counts. */
    thresholdPercent: z.number().gt(0).max(100),
    aggregate: z.boolean(),
    maxChainDepth: z.number().int().min(1).max(10),
    /** Reaching the depth limit or finding a circular chain always goes to a human. */
    onLimitReached: z.literal("escalate"),
  }),

  jurisdictions: z
    .array(
      z.strictObject({
        country: z.string().regex(/^[A-Z]{2}$/, "use an ISO 3166-1 alpha-2 code"),
        action: z.enum(JURISDICTION_ACTIONS),
        note: z.string().optional(),
        /** Place and country names that, found in a payment reference, count as a link to this country. */
        keywords: z.array(z.string().min(2)).default([]),
      }),
    )
    .refine((rows) => unique(rows.map((r) => r.country)), "each country may appear once"),

  automation: z.strictObject({
    autoClose: z.boolean(),
    autoEscalate: z.boolean(),
    // Hard locks: not configurable.
    autoBlock: z.literal(false),
    messageCustomers: z.literal(false),
    dataAccess: z.literal("read_only"),
    blockApprovalsRequired: z.literal(2),
  }),

  critic: z.strictObject({
    maxRounds: z.number().int().min(1).max(3),
    confidenceFloorForClose: unit,
    /** Records that fail data-quality rules can never support an automatic close. */
    abstainOnInvalidData: z.literal(true),
  }),

  models: perAgent(AgentModelSchema),

  /** Zetaris role each agent queries under. The role decides which columns it can see. */
  masking: perAgent(nonEmpty),

  /**
   * The challenger argues against a recommendation to close. It runs only when one of the triggers applies and can
   * only make the outcome more cautious.
   */
  challenger: z.strictObject({
    enabled: z.boolean(),
    /** Challenge a close whose confidence is below this. */
    confidenceBelow: z.number().min(0).max(1),
    /** Challenge a close when the name similarity is at least this. */
    nameScoreAtLeast: z.number().min(0).max(1),
    /** Challenge a close when a data-quality rule fails on the records. */
    onDataQualityIssue: z.boolean(),
  }),

  /**
   * Ask the models for answers constrained to a JSON Schema instead of "reason, then end with JSON". The model
   * reasons inside a field of the answer, so there is nothing to extract and nothing to cut off.
   */
  structuredOutput: z.boolean().default(true),

  /**
   * What each agent may read, checked by our own SQL guard before a query is sent, whichever credential answers:
   * the tables it may name and the columns it may never name. An agent with no tables reads no data.
   */
  agentAccess: perAgent(z.strictObject({ tables: z.array(nonEmpty), denyColumns: z.array(nonEmpty) })),

  guards: z.strictObject({
    tippingOffPolicy: z.string().min(20),
    injectionPatterns: z.array(regexSource).min(1),
    /** Words and phrases that must never appear in text for a customer: they reveal screening or an investigation. */
    tippingOffPatterns: z.array(regexSource).min(1),
  }),
});

export type Policy = z.infer<typeof PolicySchema>;

export interface PolicyIssue {
  path: string;
  message: string;
}

export type PolicyValidation = { ok: true; policy: Policy } | { ok: false; errors: PolicyIssue[] };

/** Validate any value as a policy. Errors carry a dotted path so an editor can show them inline. */
export function validatePolicy(input: unknown): PolicyValidation {
  const parsed = PolicySchema.safeParse(input);
  if (parsed.success) return { ok: true, policy: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

export function parsePolicy(input: unknown): Policy {
  const result = validatePolicy(input);
  if (!result.ok) {
    throw new AppError("validation", "invalid policy", { details: { issues: result.errors } });
  }
  return result.policy;
}

/** Content hash of a policy. Two policies with the same behaviour and version hash the same. */
export function policyHash(policy: Policy): string {
  return hashValue(policy);
}

/** A reference to the exact policy a decision was made under. */
export const PolicyRefSchema = z.strictObject({
  version: PolicyVersionSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PolicyRef = z.infer<typeof PolicyRefSchema>;

export function policyRef(policy: Policy): PolicyRef {
  return { version: policy.version, hash: policyHash(policy) };
}

/** Read and validate a policy file. Relative paths are resolved from the repository root. */
export function loadPolicyFile(path: string): Policy {
  const resolved = resolveProjectPath(path);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    throw new AppError("config_missing", `cannot read policy file ${resolved}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError("validation", `policy file ${resolved} is not valid JSON`);
  }
  return parsePolicy(json);
}

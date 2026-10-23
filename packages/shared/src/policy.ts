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
  /**
   * Which app identity the step's calls are sent under. "reasoning" and "guard" are bound separately in the Nightshift
   * cockpit (the guard to the local model, reasoning to the deep mode); "default" uses the application's own identity.
   */
  identity: z.enum(["default", "reasoning", "guard"]).default("default"),
  /**
   * The identity the fast retry is sent under after a failed or unusable try. A cockpit bind replaces the mode a request
   * asks for, so a retry under the same bound identity goes back to the same lane; "guard" sends it to the local model
   * instead. Absent means the step's own identity. Added in policy version 6.
   */
  retryIdentity: z.enum(["default", "reasoning", "guard"]).optional(),
});
export type AgentModel = z.infer<typeof AgentModelSchema>;

const perAgent = <T extends z.ZodType>(schema: T) =>
  z.strictObject({
    triage: schema,
    evidence: schema,
    screener: schema,
    matching: schema,
    ownership: schema,
    decision: schema,
    critic: schema,
    challenger: schema,
    policy_guard: schema,
    reporter: schema,
  });

/**
 * The kinds of risk the screener may report from free text. The list is closed: anything else the model names is
 * recorded as "other", which blocks a close like every other type.
 */
export const SCREENER_SIGNAL_TYPES = [
  "alias_or_former_name",
  "relationship_to_listed_party",
  "ownership_or_control_claim",
  "sanctioned_jurisdiction_link",
  "adverse_media",
  "instruction_to_reviewer",
  "other",
] as const;
export const ScreenerSignalTypeSchema = z.enum(SCREENER_SIGNAL_TYPES);
export type ScreenerSignalType = z.infer<typeof ScreenerSignalTypeSchema>;

const regexSource = nonEmpty.refine((s) => {
  try {
    new RegExp(s, "iu");
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

const PolicyShape = z.strictObject({
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

  /**
   * What a free-text note or payment reference must carry to count as documentary evidence, and not just a claim. A
   * close that rests on a claim goes to NEED_MORE_INFO. Added in policy version 2; version 3 moved its wording into the approved definitions (false_positive@2).
   */
  evidenceStandard: z
    .strictObject({
      /** The approved definition, as id@version in the semantic layer, that states the standard in words. */
      definition: z.string().regex(/^[a-z_]+@\d+$/),
      requireCheckReference: z.boolean(),
      requireDocumentNumber: z.boolean(),
      requireDate: z.boolean(),
      requireNamedCounterpartyForPayments: z.boolean(),
    })
    .default({
      definition: "false_positive@2",
      requireCheckReference: true,
      requireDocumentNumber: true,
      requireDate: true,
      requireNamedCounterpartyForPayments: true,
    }),

  /**
   * The screener reads the free text of a case (customer notes, payment references, list remarks) on the local model
   * and returns structured facts only. Those facts, never the text, are what the cloud models see. The model it runs
   * on is `models.screener` (identity "guard", bound to the local model in the cockpit). Added in policy version 6.
   */
  screener: z
    .strictObject({
      /**
       * Off only for a comparison run: the free text is then not read, there are no signals, and the policy guard's
       * screener rule passes with a note saying the screener is off.
       */
      enabled: z.boolean().default(true),
      /**
       * A risk signal at or above this confidence blocks a close. It is capped so that the threshold cannot be set
       * high enough to let every signal through.
       */
      confidenceThreshold: z.number().min(0).max(0.9),
      /**
       * "other" is the type a model reaches for when nothing fits, so it blocks a close only from this confidence;
       * between the normal threshold and this one it is shown as a flag.
       */
      otherConfidenceThreshold: z.number().min(0).max(0.95).default(0.7),
      /** The closed list of signal types. It must keep "other" so that a type nobody listed is still counted. */
      signalTypes: z
        .array(ScreenerSignalTypeSchema)
        .min(1)
        .refine(unique, "signal types must be unique")
        .refine((t) => t.includes("other") && t.includes("instruction_to_reviewer"), {
          message: 'signal types must keep "other" and "instruction_to_reviewer"',
        }),
      /** The longest stretch of one field the screener reads; the rest is not read and the case says so. */
      maxFieldChars: positiveInt.max(20_000),
    })
    .refine((s) => s.otherConfidenceThreshold >= s.confidenceThreshold, {
      message: "otherConfidenceThreshold must not be below confidenceThreshold",
      path: ["otherConfidenceThreshold"],
    })
    .default({
      enabled: true,
      confidenceThreshold: 0.5,
      otherConfidenceThreshold: 0.7,
      signalTypes: [...SCREENER_SIGNAL_TYPES],
      maxFieldChars: 4000,
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
   * How much a person does. Level 0: a person approves every alert. Level 1: a close the desk is certain of may be
   * closed without waiting, within a daily cap, with a random share sent to a person for quality assurance. Level 1
   * is switched off at once by the kill switch. What is locked cannot be changed by any draft: an escalation or a
   * request for information always goes to a person, and a block always needs two different approvers.
   */
  autonomy: z
    .strictObject({
      level: z.union([z.literal(0), z.literal(1)]),
      autoClose: z.strictObject({
        /** A close needs at least this confidence to be closed without a person; never below the critic's floor. */
        confidenceAtLeast: unit,
        /** The share of automatic closes sent to a person at random. At least 5 percent. */
        qaSampleRate: z.number().min(0.05).max(1),
        /** The most alerts closed automatically in one UTC day; the rest wait for a person. */
        dailyCap: positiveInt.max(100_000),
      }),
      escalationsAlwaysToPerson: z.literal(true),
      moreInfoAlwaysToPerson: z.literal(true),
      blockNeedsTwoApprovers: z.literal(true),
    })
    .default({
      level: 0,
      autoClose: { confidenceAtLeast: 0.9, qaSampleRate: 0.1, dailyCap: 50 },
      escalationsAlwaysToPerson: true,
      moreInfoAlwaysToPerson: true,
      blockNeedsTwoApprovers: true,
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

export const PolicySchema = PolicyShape.refine(
  (p) => p.autonomy.autoClose.confidenceAtLeast >= p.critic.confidenceFloorForClose,
  {
    message: "an automatic close needs at least the confidence the critic requires for any close",
    path: ["autonomy", "autoClose", "confidenceAtLeast"],
  },
);
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

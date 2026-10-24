import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PinnedModeSchema } from "./modes.js";
import { Secret } from "./secret.js";

/**
 * Configuration is layered, lowest priority first:
 *   1. config/default.json          committed, non-secret defaults (URLs, model modes, timeouts)
 *   2. config/local.json            optional, git-ignored, this machine's non-secret settings (a pinned public key)
 *   3. the file named by CONFIG_FILE  optional per-environment overrides (never secrets)
 *   4. environment variables        see ENV_BINDINGS; the only place secrets may come from
 *
 * No URL, model name or timeout is written in source code. Everything is validated at start-up
 * and the process refuses to run on invalid config.
 */

const positiveInt = z.number().int().positive();
const nonEmpty = z.string().min(1);
const secret = nonEmpty.transform((v) => new Secret(v));

const LOCAL_CONFIG_FILE = "config/local.json";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const ConfigSchema = z.strictObject({
  server: z.strictObject({
    host: nonEmpty,
    port: z.number().int().min(1).max(65535),
    bodyLimitBytes: positiveInt,
    shutdownTimeoutMs: positiveInt,
    /** Browser origins allowed to call the API (the review desk interface). */
    webOrigins: z.array(nonEmpty),
    /** Serve the OpenAPI description and Swagger UI at /docs. */
    docs: z.boolean().default(true),
    /**
     * Who may call the API. `on`: every route except /health needs a user's bearer token. `demo`: sample mode, where
     * the built-in demo users can be chosen with a header and reading and running reviews need no token. `off`: no
     * checks (tests only; refused in live mode). `auto` is `on` live and `demo` in sample mode.
     */
    auth: z.enum(["auto", "on", "demo", "off"]).default("auto"),
    /** File with the users, their roles and the SHA-256 of each token. Kept outside the repository. */
    usersFile: nonEmpty.optional(),
    /**
     * How often one caller may change things or start a review. A caller is the signed-in user when sign-in is on,
     * otherwise the remote address. Reads and /health are never limited. Above a limit the answer is 429 with
     * Retry-After; nothing is queued.
     */
    rateLimit: z.strictObject({
      /** Off only for tests and tools that call the app in-process. */
      enabled: z.boolean().default(true),
      /** Length of the fixed window, in milliseconds. */
      windowMs: positiveInt,
      /** Requests per window per caller to any route that is not a read. */
      writesPerWindow: positiveInt,
      /** Requests per window per caller to POST /run and POST /policy/whatif (also counted as writes). */
      reviewsPerWindow: positiveInt,
      /** Reviews (POST /run) running at once across all callers. One more is refused, not queued. */
      reviewsInFlight: positiveInt,
      /** Retry-After, in seconds, sent when a review is refused because too many are running. */
      busyRetryAfterSeconds: positiveInt,
    }),
  }),
  /** What a person's decision on a recommendation produces. Nothing here is ever sent anywhere. */
  actions: z
    .strictObject({
      /** Folder for the action records written after an approval (a local outbox). */
      outboxDir: nonEmpty,
      /** Ed25519 private key (PEM) outside the repository. Without it records are hash-sealed, not signed. */
      signingKeyFile: nonEmpty.optional(),
      /** Ed25519 public key (base64) that signed records are checked against. */
      publicKey: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/, "expected a base64 Ed25519 public key")
        .optional(),
      /**
       * Optional, off by default: Scout Intent checks each next-action record before it is sealed and refuses one whose
       * text does not match its kind or the person's decision (packages/agents/src/action-intent.ts).
       */
      scoutIntent: z.boolean().default(false),
    })
    .default({ outboxDir: "outbox", scoutIntent: false }),
  logging: z.strictObject({
    level: z.enum(LOG_LEVELS),
    dir: nonEmpty,
    stdout: z.boolean(),
    /** Echo one short readable line per trace event instead of the JSON line. The file always gets the JSON. */
    pretty: z.boolean().default(false),
  }),
  sampleMode: z.boolean(),
  /**
   * Cloud privacy mode. "pseudonymise" replaces the case's names, identifiers, dates of birth, addresses and country
   * values with tokens in every cloud prompt and maps them back locally; "off" (the default) sends them as they are.
   */
  privacyMode: z.enum(["off", "pseudonymise"]).default("off"),
  /** Illustrative unit costs for the cost panel. They are assumptions, not prices: set your own. */
  costs: z.strictObject({
    currency: nonEmpty,
    cloudInputPerMillionTokens: z.number().nonnegative(),
    cloudOutputPerMillionTokens: z.number().nonnegative(),
    localPerMillionTokens: z.number().nonnegative(),
    perDataQuery: z.number().nonnegative(),
    note: nonEmpty,
  }),
  /**
   * Assumptions behind the "analyst minutes saved" figure in the exam report and the interface. They are not
   * measured: set the times your own analysts take.
   */
  report: z.strictObject({
    /** Minutes an analyst spends on one alert, investigating it from scratch. */
    minutesPerAlert: z.number().positive(),
    /** Minutes to confirm a close from the evidence the desk cites. */
    minutesToConfirmClose: z.number().nonnegative(),
    /**
     * An industry estimate of the minutes an analyst spends investigating one sanctions alert, as a range. It is shown
     * beside the desk's own time and cost per alert, always labelled as an estimate: no vendor source was verified.
     */
    manualMinutesRange: z.strictObject({ low: z.number().positive(), high: z.number().positive() }),
  }),
  /** Saved Zetaris answers used in sample mode. */
  sampleCache: nonEmpty,
  zetaris: z.strictObject({
    restUrl: z.url(),
    orgId: nonEmpty,
    requestTimeoutMs: positiveInt,
    /** Admin key. Used by the one-time setup tooling only; runtime reads use the per-role tokens below. */
    apiKey: secret.optional(),
    /** One API token per runtime identity. A missing token falls back to `apiKey`, and that is logged. */
    tokens: z
      .strictObject({
        evidence: secret.optional(),
        reviewer: secret.optional(),
        eval: secret.optional(),
        /** Optional per-step identities (role granted only that step's tables); without one the step reads as evidence. */
        ownership: secret.optional(),
        critic: secret.optional(),
        memory: secret.optional(),
        document: secret.optional(),
        rescreen: secret.optional(),
      })
      .default({}),
    /**
     * When a role token is refused for lack of permission, retry once with the admin key and stop using that
     * role token. Every record says which credential answered. Off by default: a refusal is an error.
     */
    fallbackOnDenied: z.boolean().default(false),
    /**
     * At start-up, make each runtime identity read the model and refuse to start, with the fix steps, if any is
     * refused. Only applies to a live run that has role tokens and no admin fallback.
     */
    requireRoleAccess: z.boolean().default(true),
    /** The USL namespace and model the agents are allowed to read. */
    namespace: nonEmpty,
    usl: nonEmpty,
    /** Maximum rows requested per query. */
    maxRows: positiveInt,
    /** Where list files are placed so the Lightning file store can read them. */
    fileStore: z.strictObject({
      container: nonEmpty,
      database: nonEmpty,
      folder: nonEmpty,
    }),
  }),
  nightshift: z.strictObject({
    baseUrl: z.url(),
    appId: nonEmpty,
    /** App id used for evaluation runs. Nightshift's response cache is per app, so evals use their own. */
    evalAppId: nonEmpty,
    scope: nonEmpty,
    requestTimeoutMs: positiveInt,
    /** Each lane is pinned to an explicit mode. meterless/auto is rejected. */
    models: z.strictObject({
      fast: PinnedModeSchema,
      deep: PinnedModeSchema,
      judge: PinnedModeSchema,
    }),
    /** Ed25519 public keys (base64) of the runtime whose receipts we trust. Public, so not a secret. */
    receiptPublicKeys: z.array(z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "expected a base64 Ed25519 public key")),
    runtimeToken: secret.optional(),
    /**
     * App identities for the two kinds of work. The cockpit can bind each app to a routing mode, so the guard identity
     * can be bound to the local model and the reasoning identity to the deep mode. A step without one uses `appId`.
     */
    apps: z.strictObject({ reasoning: nonEmpty, guard: nonEmpty }).optional(),
    /** After a 429 from the runtime (or the cloud behind it): wait, then try the same mode again. */
    rateLimit: z.strictObject({ retries: z.number().int().min(0).max(6), baseDelayMs: positiveInt }).default({
      retries: 3,
      baseDelayMs: 3000,
    }),
  }),
  ollama: z.strictObject({
    baseUrl: z.url(),
    model: nonEmpty,
    requestTimeoutMs: positiveInt,
  }),
  limits: z.strictObject({
    criticMaxRounds: positiveInt.max(10),
    healthProbeTimeoutMs: positiveInt,
  }),
  events: z.strictObject({
    /** Events kept per run so a late subscriber (live view, replay) can catch up. */
    replayLimit: positiveInt,
    /** Runs kept in memory; the oldest finished run is dropped first. */
    maxRuns: positiveInt,
  }),
  policy: z.strictObject({
    /** Initial policy document, relative to the repository root unless absolute. */
    file: nonEmpty,
  }),
});

export type Config = z.output<typeof ConfigSchema>;

type ValueKind = "string" | "number" | "boolean" | "list";
interface EnvBinding {
  env: string;
  path: readonly string[];
  kind: ValueKind;
}

/** Which environment variable overrides which config key. */
const ENV_BINDINGS: readonly EnvBinding[] = [
  { env: "HOST", path: ["server", "host"], kind: "string" },
  { env: "WEB_ORIGINS", path: ["server", "webOrigins"], kind: "list" },
  { env: "DOCS_ENABLED", path: ["server", "docs"], kind: "boolean" },
  { env: "AUTH_MODE", path: ["server", "auth"], kind: "string" },
  { env: "DESK_USERS_FILE", path: ["server", "usersFile"], kind: "string" },
  { env: "RATE_LIMIT_ENABLED", path: ["server", "rateLimit", "enabled"], kind: "boolean" },
  { env: "RATE_LIMIT_WINDOW_MS", path: ["server", "rateLimit", "windowMs"], kind: "number" },
  { env: "RATE_LIMIT_WRITES", path: ["server", "rateLimit", "writesPerWindow"], kind: "number" },
  { env: "RATE_LIMIT_REVIEWS", path: ["server", "rateLimit", "reviewsPerWindow"], kind: "number" },
  { env: "RATE_LIMIT_REVIEWS_IN_FLIGHT", path: ["server", "rateLimit", "reviewsInFlight"], kind: "number" },
  { env: "DESK_OUTBOX_DIR", path: ["actions", "outboxDir"], kind: "string" },
  { env: "DESK_SIGNING_KEY_FILE", path: ["actions", "signingKeyFile"], kind: "string" },
  { env: "DESK_SIGNING_PUBLIC_KEY", path: ["actions", "publicKey"], kind: "string" },
  { env: "DESK_SCOUT_INTENT", path: ["actions", "scoutIntent"], kind: "boolean" },
  { env: "PORT", path: ["server", "port"], kind: "number" },
  { env: "LOG_LEVEL", path: ["logging", "level"], kind: "string" },
  { env: "LOG_DIR", path: ["logging", "dir"], kind: "string" },
  { env: "TRACE_STDOUT_PRETTY", path: ["logging", "pretty"], kind: "boolean" },
  { env: "SAMPLE_MODE", path: ["sampleMode"], kind: "boolean" },
  { env: "PRIVACY_MODE", path: ["privacyMode"], kind: "string" },
  { env: "ZETARIS_REST_URL", path: ["zetaris", "restUrl"], kind: "string" },
  { env: "ZETARIS_ORG_ID", path: ["zetaris", "orgId"], kind: "string" },
  { env: "ZETARIS_API_KEY", path: ["zetaris", "apiKey"], kind: "string" },
  { env: "ZETARIS_TOKEN_EVIDENCE", path: ["zetaris", "tokens", "evidence"], kind: "string" },
  { env: "ZETARIS_TOKEN_REVIEWER", path: ["zetaris", "tokens", "reviewer"], kind: "string" },
  { env: "ZETARIS_TOKEN_EVAL", path: ["zetaris", "tokens", "eval"], kind: "string" },
  { env: "ZETARIS_TOKEN_OWNERSHIP", path: ["zetaris", "tokens", "ownership"], kind: "string" },
  { env: "ZETARIS_TOKEN_CRITIC", path: ["zetaris", "tokens", "critic"], kind: "string" },
  { env: "ZETARIS_TOKEN_MEMORY", path: ["zetaris", "tokens", "memory"], kind: "string" },
  { env: "ZETARIS_TOKEN_DOCUMENT", path: ["zetaris", "tokens", "document"], kind: "string" },
  { env: "ZETARIS_TOKEN_RESCREEN", path: ["zetaris", "tokens", "rescreen"], kind: "string" },
  { env: "METERLESS_BASE_URL", path: ["nightshift", "baseUrl"], kind: "string" },
  { env: "METERLESS_APP_ID", path: ["nightshift", "appId"], kind: "string" },
  { env: "METERLESS_EVAL_APP_ID", path: ["nightshift", "evalAppId"], kind: "string" },
  { env: "METERLESS_APP_REASONING", path: ["nightshift", "apps", "reasoning"], kind: "string" },
  { env: "METERLESS_APP_GUARD", path: ["nightshift", "apps", "guard"], kind: "string" },
  { env: "METERLESS_RUNTIME_TOKEN", path: ["nightshift", "runtimeToken"], kind: "string" },
  { env: "METERLESS_MODEL_FAST", path: ["nightshift", "models", "fast"], kind: "string" },
  { env: "METERLESS_MODEL_DEEP", path: ["nightshift", "models", "deep"], kind: "string" },
  { env: "METERLESS_MODEL_JUDGE", path: ["nightshift", "models", "judge"], kind: "string" },
  { env: "METERLESS_RECEIPT_PUBLIC_KEY", path: ["nightshift", "receiptPublicKeys"], kind: "list" },
  { env: "OLLAMA_BASE_URL", path: ["ollama", "baseUrl"], kind: "string" },
  { env: "OLLAMA_MODEL", path: ["ollama", "model"], kind: "string" },
];

/** Keys that hold secrets. They may only come from the environment, never from a file. */
const SECRET_PATHS: ReadonlyArray<readonly string[]> = [
  ["zetaris", "apiKey"],
  ["zetaris", "tokens", "evidence"],
  ["zetaris", "tokens", "reviewer"],
  ["zetaris", "tokens", "eval"],
  ["zetaris", "tokens", "ownership"],
  ["zetaris", "tokens", "critic"],
  ["zetaris", "tokens", "memory"],
  ["zetaris", "tokens", "document"],
  ["zetaris", "tokens", "rescreen"],
  ["nightshift", "runtimeToken"],
];

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

type Json = Record<string, unknown>;

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  /** Defaults file. Resolved from the repository layout when omitted. */
  defaultsPath?: string;
  /** Overrides CONFIG_FILE from the environment. */
  overridesPath?: string;
}

export function defaultConfigPath(): string {
  return fileURLToPath(new URL("../../../config/default.json", import.meta.url));
}

/** The repository root, where config/ lives. Independent of the directory a process was started from. */
export function projectRoot(): string {
  return dirname(dirname(defaultConfigPath()));
}

/** Absolute paths are kept; relative ones are resolved from the repository root. */
export function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot(), path);
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const issues: string[] = [];

  const defaults = readJsonFile(opts.defaultsPath ?? defaultConfigPath(), issues);
  // The machine-local file is read only when running for real (no environment passed in), never in tests.
  const localPath = opts.env === undefined ? resolveProjectPath(LOCAL_CONFIG_FILE) : undefined;
  const local = localPath && existsSync(localPath) ? readJsonFile(localPath, issues) : {};
  const overridesPath = opts.overridesPath ?? nonBlank(env.CONFIG_FILE);
  const overrides = overridesPath ? readJsonFile(overridesPath, issues) : {};

  issues.push(
    ...secretsInFile(defaults, "default config file"),
    ...secretsInFile(local, LOCAL_CONFIG_FILE),
    ...secretsInFile(overrides, "CONFIG_FILE"),
  );
  const fromEnv = readEnvOverrides(env, issues);

  if (issues.length > 0) throw new ConfigError(issues);

  const parsed = ConfigSchema.safeParse(deepMerge(deepMerge(deepMerge(defaults, local), overrides), fromEnv));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  // Relative paths mean "inside the project", never "wherever the process happened to start".
  const config = parsed.data;
  return { ...config, logging: { ...config.logging, dir: resolveProjectPath(config.logging.dir) } };
}

/** The same configuration, but model calls use the evaluation app id so they never share a cache with live use. */
export function forEvaluation(cfg: Config): Config {
  return { ...cfg, nightshift: { ...cfg.nightshift, appId: cfg.nightshift.evalAppId } };
}

/** Every secret value in the config, for the log redactor. */
export function secretValues(cfg: Config): string[] {
  return [
    cfg.zetaris.apiKey,
    cfg.zetaris.tokens.evidence,
    cfg.zetaris.tokens.reviewer,
    cfg.zetaris.tokens.eval,
    cfg.nightshift.runtimeToken,
  ]
    .filter((s): s is Secret => s !== undefined)
    .map((s) => s.reveal());
}

/** A log-safe view of the config: secrets are reported as set/unset, never by value. */
export function describeConfig(cfg: Config) {
  return {
    sampleMode: cfg.sampleMode,
    privacyMode: cfg.privacyMode,
    server: { host: cfg.server.host, port: cfg.server.port, rateLimit: cfg.server.rateLimit },
    zetaris: {
      restUrl: cfg.zetaris.restUrl,
      orgId: cfg.zetaris.orgId,
      namespace: cfg.zetaris.namespace,
      usl: cfg.zetaris.usl,
      apiKeySet: cfg.zetaris.apiKey !== undefined,
      roleTokensSet: {
        evidence: cfg.zetaris.tokens.evidence !== undefined,
        reviewer: cfg.zetaris.tokens.reviewer !== undefined,
        eval: cfg.zetaris.tokens.eval !== undefined,
      },
    },
    nightshift: {
      baseUrl: cfg.nightshift.baseUrl,
      appId: cfg.nightshift.appId,
      evalAppId: cfg.nightshift.evalAppId,
      models: cfg.nightshift.models,
      receiptKeysPinned: cfg.nightshift.receiptPublicKeys.length,
      runtimeTokenSet: cfg.nightshift.runtimeToken !== undefined,
    },
    ollama: { baseUrl: cfg.ollama.baseUrl, model: cfg.ollama.model },
    limits: cfg.limits,
  };
}

// ---- internals -----------------------------------------------------------------------------

/** Issues for any secret key found in a file layer. Secrets may only come from the environment. */
function secretsInFile(layer: Json, label: string): string[] {
  return SECRET_PATHS.filter((path) => getPath(layer, path) !== undefined).map(
    (path) => `${path.join(".")} must not be set in the ${label}; provide it through the environment`,
  );
}

function readEnvOverrides(env: Record<string, string | undefined>, issues: string[]): Json {
  const fromEnv: Json = {};
  for (const binding of ENV_BINDINGS) {
    const raw = nonBlank(env[binding.env]);
    if (raw === undefined) continue;
    const value = coerce(binding, raw, issues);
    if (value !== undefined) setPath(fromEnv, binding.path, value);
  }
  return fromEnv;
}

function nonBlank(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function readJsonFile(path: string, issues: string[]): Json {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    issues.push(`cannot read config file ${path}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Json;
  } catch {
    issues.push(`config file ${path} is not a valid JSON object`);
    return {};
  }
}

function coerce(binding: EnvBinding, raw: string, issues: string[]): string | number | boolean | string[] | undefined {
  switch (binding.kind) {
    case "string":
      return raw;
    case "list":
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        issues.push(`${binding.env} must be a number`);
        return undefined;
      }
      return n;
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (v === "true") return true;
      if (v === "false") return false;
      issues.push(`${binding.env} must be "true" or "false"`);
      return undefined;
    }
  }
}

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const current = out[k];
    out[k] = isRecord(current) && isRecord(v) ? deepMerge(current, v) : v;
  }
  return out;
}

function getPath(obj: Json, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj: Json, path: readonly string[], value: unknown): void {
  let cur = obj;
  path.slice(0, -1).forEach((key) => {
    const next = cur[key];
    if (isRecord(next)) {
      cur = next;
    } else {
      const created: Json = {};
      cur[key] = created;
      cur = created;
    }
  });
  const last = path[path.length - 1];
  if (last !== undefined) cur[last] = value;
}

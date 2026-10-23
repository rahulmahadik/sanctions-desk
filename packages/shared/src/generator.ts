import type { Config } from "./config.js";
import { AppError, type StructuredError, toStructuredError } from "./errors.js";
import { type FetchLike, httpRequest } from "./http.js";
import { LANES, type Lane, PINNED_MODE } from "./modes.js";
import { extractReceipt, type ReceiptEnvelope, type ReceiptSummary } from "./receipts.js";
import type { TraceEventInput } from "./schemas.js";
import type { Secret } from "./secret.js";

/**
 * The generator seam. Agents and engines never call a model directly: they receive one
 * `Generator` function. Which provider answers is decided here, by configuration.
 *
 *   Nightshift (primary)  ->  Ollama (backup)  ->  fallback-rules (sample mode only)
 *
 * Nightshift is always called with a pinned mode (meterless/fast, meterless/deep, ...), never
 * meterless/auto. If a mode is dead (HTTP 410, 400 class_no_route, or a cloud "Function not found") the next configured mode is
 * tried once; after that the call fails over to Ollama. Every attempt is reported with the mode we
 * requested and the model the runtime says answered.
 */

export type { Lane } from "./modes.js";
export type Provider = "nightshift" | "ollama" | "fallback-rules";
export type RouteKind = "local" | "cloud";

export interface GenerateRequest {
  prompt: string;
  system?: string;
  /** Picks the Nightshift mode from the configuration (default: fast). Ignored if `model` is set. */
  lane?: Lane;
  /** An explicit pinned Nightshift mode, for example "meterless/text.deep". Ollama ignores it. */
  model?: string;
  /**
   * Start of the answer, sent as a final assistant message (for example "{" to get a JSON object straight away).
   * The result text always includes it, whether or not the provider repeats it.
   */
  prefill?: string;
  /** Ask this provider only (when it is in the chain). Used for a last try after the primary gave unusable answers. */
  provider?: Provider;
  /** Which app identity to send the request under: the one for reasoning or the one for the guard. */
  identity?: "reasoning" | "guard";
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Ask for a JSON object and nothing else. Ollama honours it by constraining the answer to JSON, which stops a
   * thinking model from spending its whole budget on reasoning text. Nightshift ignores it.
   */
  jsonMode?: boolean;
  /**
   * Constrain the answer to this JSON Schema (`response_format` of type `json_schema`, strict). Nightshift and Ollama
   * both honour it, so the model cannot wrap its answer in reasoning text or leave it unfinished.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

/** A Nightshift mode that no longer routes. */
export interface DeadRoute {
  model: string;
  status: number;
  code?: string;
}

export interface GenerateResult {
  text: string;
  provider: Provider;
  /** What we asked for: a Nightshift mode, or the Ollama model name. */
  requestedModel: string;
  /** What the runtime says actually answered. */
  routedModel: string;
  /** "local" or "cloud" as reported by the runtime; null when it did not say. */
  routeKind: RouteKind | null;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** Why the model stopped: "stop" for a finished answer, "length" when the token limit cut it off. */
  finishReason?: string;
  /** The mode the runtime says it served. If it differs from `requestedModel`, `modeMismatch` is true. */
  servedMode?: string;
  modeMismatch: boolean;
  /** True when the runtime answered from its cache instead of running a model. */
  fromCache?: boolean;
  /** Modes that were dead and skipped before this answer. */
  deadRoutes?: DeadRoute[];
  /** The app identity the request was sent under. */
  app?: string;
  /** Signed receipt summary and the full envelope it was taken from (store the envelope beside the trace). */
  receipt?: ReceiptSummary;
  receiptEnvelope?: ReceiptEnvelope;
  /** Providers that failed before this one answered, in order. */
  fellBackFrom?: Array<{ provider: Provider; error: StructuredError }>;
}

export type Generator = (req: GenerateRequest) => Promise<GenerateResult>;

/** One HTTP attempt to a model provider. Reported through `onAttempt` so every try is logged. */
export interface ModelAttempt {
  provider: Provider;
  requestedModel: string;
  routedModel?: string;
  servedMode?: string;
  status?: number;
  outcome: "ok" | "dead_route" | "error";
  errorType?: string;
  latencyMs: number;
}
export type AttemptHook = (attempt: ModelAttempt) => void;

interface NamedGenerator {
  provider: Provider;
  generate: Generator;
}

export interface NightshiftOptions {
  baseUrl: string;
  token?: Secret;
  appId: string;
  scope: string;
  models: Record<Lane, string>;
  timeoutMs: number;
  receiptPublicKeys?: readonly string[];
  /** Identities for reasoning and for the guard; a request names one with `identity`. */
  apps?: { reasoning: string; guard: string };
  /** What to do after a 429. Wait `baseDelayMs`, then twice that, and so on, up to `retries` times. */
  rateLimit?: { retries: number; baseDelayMs: number };
  /** Replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onAttempt?: AttemptHook;
  fetchImpl?: FetchLike;
}

export function createNightshiftGenerator(opts: NightshiftOptions): Generator {
  return async (req) => {
    if (!opts.token) {
      throw new AppError("config_missing", "the Nightshift runtime token is not set", { recoverable: true });
    }
    const primary = req.model ?? opts.models[req.lane ?? "fast"];
    if (!PINNED_MODE.test(primary)) {
      throw new AppError("validation", `"${primary}" is not a pinned Nightshift mode; meterless/auto is not allowed`);
    }

    const deadRoutes: DeadRoute[] = [];
    for (const mode of modesToTry(opts.models, primary)) {
      const sent = await sendPaced(opts, req, mode);
      const dead = deadRouteOf(mode, sent.status, sent.text);
      if (dead) {
        deadRoutes.push(dead);
        opts.onAttempt?.({
          provider: "nightshift",
          requestedModel: mode,
          status: sent.status,
          outcome: "dead_route",
          latencyMs: Math.round(sent.ms),
        });
        continue;
      }
      const answer = readNightshiftAnswer(opts, mode, sent, deadRoutes, appFor(opts, req));
      return { ...answer, text: withPrefill(answer.text, req.prefill) };
    }
    throw new AppError("route_dead", "no Nightshift mode could route this request", {
      recoverable: true,
      details: { dead_routes: deadRoutes },
    });
  };
}

/** The mode asked for, then (once) the next configured mode if it is dead. */
function modesToTry(models: Record<Lane, string>, primary: string): string[] {
  const configured = [...new Set(LANES.map((lane) => models[lane]))];
  const at = configured.indexOf(primary);
  const rotated = at === -1 ? configured : [...configured.slice(at + 1), ...configured.slice(0, at)];
  const next = rotated.find((mode) => mode !== primary);
  return next === undefined ? [primary] : [primary, next];
}

const appFor = (opts: NightshiftOptions, req: GenerateRequest): string =>
  (req.identity ? opts.apps?.[req.identity] : undefined) ?? opts.appId;

/** The runtime or the cloud behind it said "too many requests" (the runtime wraps it in a 502). */
export const isRateLimited = (status: number, text: string): boolean =>
  status === 429 || (status >= 500 && /\b429\b|Too Many Requests/i.test(text));

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send, and when the answer is a 429, wait and send the same request again (up to the configured number of times).
 * The wait also holds back the calls that follow, so a burst does not keep tripping the same limit.
 */
async function sendPaced(opts: NightshiftOptions, req: GenerateRequest, mode: string) {
  const policy = opts.rateLimit ?? { retries: 0, baseDelayMs: 0 };
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  for (let attempt = 0; ; attempt += 1) {
    const hold = cooldowns.get(opts.baseUrl) ?? 0;
    if (hold > now()) await sleep(hold - now());
    const sent = await sendToNightshift(opts, req, mode);
    if (!isRateLimited(sent.status, sent.text) || attempt >= policy.retries) return sent;
    const wait = policy.baseDelayMs * 2 ** attempt;
    cooldowns.set(opts.baseUrl, now() + wait);
    opts.onAttempt?.({
      provider: "nightshift",
      requestedModel: mode,
      status: sent.status,
      outcome: "error",
      errorType: "rate_limited",
      latencyMs: Math.round(sent.ms),
    });
  }
}

/** When each runtime may be called again after a 429, shared by every generator talking to it. */
const cooldowns = new Map<string, number>();

async function sendToNightshift(opts: NightshiftOptions, req: GenerateRequest, mode: string) {
  try {
    return await httpRequest(joinUrl(opts.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token?.reveal() ?? ""}`,
        "meterless-app": appFor(opts, req),
        "meterless-scope": opts.scope,
      },
      body: chatBody(mode, req),
      timeoutMs: req.timeoutMs ?? opts.timeoutMs,
      signal: req.signal,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    opts.onAttempt?.({
      provider: "nightshift",
      requestedModel: mode,
      outcome: "error",
      errorType: toStructuredError(err).type,
      latencyMs: 0,
    });
    throw err;
  }
}

/**
 * The cloud function behind a mode no longer exists. Nightshift passes the upstream refusal on, often
 * wrapped in a 502, as text like: 404: {"status":404,"title":"Not Found","detail":"Function '<id>': Not Found ..."}.
 */
const FUNCTION_NOT_FOUND = /Function\s+'[^']*'\s*:?\s*Not Found/i;

/** HTTP 410 (model retired), 400 class_no_route and a cloud "Function not found" all mean this mode has no route. */
function deadRouteOf(model: string, status: number, text: string): DeadRoute | undefined {
  if (status === 410) return { model, status };
  if (status === 400 && text.includes("class_no_route")) return { model, status, code: "class_no_route" };
  if (status >= 400 && FUNCTION_NOT_FOUND.test(text)) return { model, status, code: "function_not_found" };
  return undefined;
}

function readNightshiftAnswer(
  opts: NightshiftOptions,
  mode: string,
  sent: { status: number; text: string; ms: number },
  deadRoutes: DeadRoute[],
  app: string,
): GenerateResult {
  const latencyMs = Math.round(sent.ms);
  try {
    const body = parseChatResponse("nightshift", sent.status, sent.text);
    const meterless = asRecord(body.meterless);
    const kind = asRecord(meterless?.winning_route)?.kind;
    const routedModel = asString(meterless?.routed_model) ?? asString(body.model) ?? mode;
    const servedMode = asString(meterless?.provider_model);
    const receipt = extractReceipt(meterless, opts.receiptPublicKeys ?? []);
    const result: GenerateResult = {
      text: extractContent("nightshift", body),
      provider: "nightshift",
      app,
      requestedModel: mode,
      routedModel,
      routeKind: kind === "local" || kind === "cloud" ? kind : null,
      latencyMs,
      usage: extractUsage(body),
      finishReason: finishReasonOf(body),
      servedMode,
      modeMismatch: servedMode !== undefined && servedMode !== mode,
      fromCache: typeof meterless?.from_cache === "boolean" ? meterless.from_cache : undefined,
      ...(deadRoutes.length > 0 ? { deadRoutes } : {}),
      ...(receipt ? { receipt: receipt.summary, receiptEnvelope: receipt.envelope } : {}),
    };
    opts.onAttempt?.({
      provider: "nightshift",
      requestedModel: mode,
      routedModel,
      servedMode,
      status: sent.status,
      outcome: "ok",
      latencyMs,
    });
    return result;
  } catch (err) {
    opts.onAttempt?.({
      provider: "nightshift",
      requestedModel: mode,
      status: sent.status,
      outcome: "error",
      errorType: toStructuredError(err).type,
      latencyMs,
    });
    throw err;
  }
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  onAttempt?: AttemptHook;
  fetchImpl?: FetchLike;
}

/** Backup provider. It always uses its own configured model: Nightshift mode names mean nothing to it. */
export function createOllamaGenerator(opts: OllamaOptions): Generator {
  return async (req) => {
    const requestedModel = opts.model;
    let sent: Awaited<ReturnType<typeof httpRequest>>;
    try {
      sent = await httpRequest(joinUrl(opts.baseUrl, "/chat/completions"), {
        method: "POST",
        body: {
          ...chatBody(requestedModel, req),
          ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
        },
        timeoutMs: req.timeoutMs ?? opts.timeoutMs,
        signal: req.signal,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      opts.onAttempt?.({
        provider: "ollama",
        requestedModel,
        outcome: "error",
        errorType: toStructuredError(err).type,
        latencyMs: 0,
      });
      throw err;
    }
    const latencyMs = Math.round(sent.ms);
    try {
      const body = parseChatResponse("ollama", sent.status, sent.text);
      const routedModel = asString(body.model) ?? requestedModel;
      const result: GenerateResult = {
        text: withPrefill(extractContent("ollama", body), req.prefill),
        provider: "ollama",
        requestedModel,
        routedModel,
        routeKind: "local",
        latencyMs,
        usage: extractUsage(body),
        finishReason: finishReasonOf(body),
        modeMismatch: false,
      };
      opts.onAttempt?.({
        provider: "ollama",
        requestedModel,
        routedModel,
        status: sent.status,
        outcome: "ok",
        latencyMs,
      });
      return result;
    } catch (err) {
      opts.onAttempt?.({
        provider: "ollama",
        requestedModel,
        status: sent.status,
        outcome: "error",
        errorType: toStructuredError(err).type,
        latencyMs,
      });
      throw err;
    }
  };
}

/** Deterministic, clearly labelled generator for SAMPLE_MODE when no model is reachable. */
export function createFallbackRulesGenerator(rules: (req: GenerateRequest) => string): Generator {
  return async (req) => {
    const start = performance.now();
    const text = rules(req);
    return {
      text,
      provider: "fallback-rules",
      requestedModel: "fallback-rules",
      routedModel: "fallback-rules",
      routeKind: "local",
      latencyMs: Math.round(performance.now() - start),
      modeMismatch: false,
    };
  };
}

/** Try each generator in order. Only recoverable failures move on to the next one. */
/** Only the provider the request names, when the chain has it; otherwise the whole chain. */
function providersFor(chain: NamedGenerator[], wanted: Provider | undefined): NamedGenerator[] {
  const only = chain.filter((p) => p.provider === wanted);
  return only.length > 0 ? only : chain;
}

export function createGeneratorChain(
  chain: NamedGenerator[],
  hooks: { onFallback?: (from: Provider, error: StructuredError) => void } = {},
): Generator {
  if (chain.length === 0) throw new Error("generator chain needs at least one provider");
  return async (req) => {
    const failures: Failure[] = [];
    for (const { provider, generate } of providersFor(chain, req.provider)) {
      const outcome = await attempt(generate, req);
      if (outcome.ok) return failures.length > 0 ? { ...outcome.result, fellBackFrom: failures } : outcome.result;
      if (req.signal?.aborted) throw outcome.cause;
      failures.push({ provider, error: outcome.error });
      hooks.onFallback?.(provider, outcome.error);
      if (!outcome.error.recoverable) throw outcome.cause;
    }
    throw allProvidersFailed(failures);
  };
}

type Failure = { provider: Provider; error: StructuredError };
type Attempt = { ok: true; result: GenerateResult } | { ok: false; cause: unknown; error: StructuredError };

async function attempt(generate: Generator, req: GenerateRequest): Promise<Attempt> {
  try {
    return { ok: true, result: await generate(req) };
  } catch (cause) {
    return { ok: false, cause, error: toStructuredError(cause) };
  }
}

function allProvidersFailed(failures: readonly Failure[]): AppError {
  return new AppError("http_error", "all model providers failed", {
    recoverable: true,
    details: {
      attempts: failures.map((f) => ({
        provider: f.provider,
        type: f.error.type,
        message: f.error.message,
        // The HTTP status, the start of the error body and the dead routes, so a failure can be classified later
        // (a retired model answers 404 or 410; a slow cloud answer times out).
        ...(typeof f.error.details?.status === "number" ? { status: f.error.details.status } : {}),
        ...(typeof f.error.details?.body === "string" ? { body: (f.error.details.body as string).slice(0, 160) } : {}),
        ...(Array.isArray(f.error.details?.dead_routes) ? { dead_routes: f.error.details.dead_routes } : {}),
      })),
    },
  });
}

export interface BuildGeneratorDeps {
  fetchImpl?: FetchLike;
  /** Required to enable fallback-rules; only used when SAMPLE_MODE is on. */
  fallbackRules?: (req: GenerateRequest) => string;
  onFallback?: (from: Provider, error: StructuredError) => void;
  /** Called for every HTTP attempt, with the requested and routed model. */
  onAttempt?: AttemptHook;
}

/** Wire the provider chain from config: Nightshift primary, Ollama backup, rules only in sample mode. */
export function buildGenerator(cfg: Config, deps: BuildGeneratorDeps = {}): Generator {
  const { nightshift, ollama } = cfg;
  const chain: NamedGenerator[] = [
    {
      provider: "nightshift",
      generate: createNightshiftGenerator({
        baseUrl: nightshift.baseUrl,
        token: nightshift.runtimeToken,
        appId: nightshift.appId,
        apps: nightshift.apps,
        rateLimit: nightshift.rateLimit,
        scope: nightshift.scope,
        models: nightshift.models,
        timeoutMs: nightshift.requestTimeoutMs,
        receiptPublicKeys: nightshift.receiptPublicKeys,
        onAttempt: deps.onAttempt,
        fetchImpl: deps.fetchImpl,
      }),
    },
    {
      provider: "ollama",
      generate: createOllamaGenerator({
        baseUrl: ollama.baseUrl,
        model: ollama.model,
        timeoutMs: ollama.requestTimeoutMs,
        onAttempt: deps.onAttempt,
        fetchImpl: deps.fetchImpl,
      }),
    },
  ];
  if (cfg.sampleMode && deps.fallbackRules) {
    chain.push({ provider: "fallback-rules", generate: createFallbackRulesGenerator(deps.fallbackRules) });
  }
  return createGeneratorChain(chain, { onFallback: deps.onFallback });
}

/**
 * The trace fields that describe one model call, so every agent logs it the same way: requested and
 * routed model, route kind, tokens, latency, the signed receipt, and any dead route, cache hit or
 * mode mismatch worth knowing about.
 */
export function modelTraceFields(result: GenerateResult): Partial<TraceEventInput> {
  const notes: Record<string, unknown> = {};
  if (result.servedMode !== undefined) notes.served_mode = result.servedMode;
  if (result.modeMismatch) notes.mode_mismatch = true;
  if (result.fromCache !== undefined) notes.from_cache = result.fromCache;
  if (result.deadRoutes) notes.dead_routes = result.deadRoutes;
  if (result.fellBackFrom) notes.fell_back_from = result.fellBackFrom.map((f) => f.provider);
  return {
    provider: result.provider,
    model_requested: result.requestedModel,
    model_used: result.routedModel,
    route_kind: result.routeKind,
    latency_ms: result.latencyMs,
    ...(result.usage?.promptTokens !== undefined ? { tokens_in: result.usage.promptTokens } : {}),
    ...(result.usage?.completionTokens !== undefined ? { tokens_out: result.usage.completionTokens } : {}),
    ...(result.receipt ? { receipt: result.receipt } : {}),
    ...(Object.keys(notes).length > 0 ? { detail: notes } : {}),
  };
}

/** Remove <think>...</think> reasoning blocks that some models put inside the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** The answer always starts with the prefill, whether or not the provider repeated it. */
export function withPrefill(text: string, prefill: string | undefined): string {
  return prefill && !text.trimStart().startsWith(prefill) ? `${prefill}${text}` : text;
}

// ---- helpers -------------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function chatBody(model: string, req: GenerateRequest): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });
  if (req.prefill) messages.push({ role: "assistant", content: req.prefill });
  return {
    model,
    messages,
    stream: false,
    ...(req.jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
          },
        }
      : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  };
}

function parseChatResponse(provider: Provider, status: number, text: string): Record<string, unknown> {
  if (status < 200 || status >= 300) {
    const retryable = status === 408 || status === 429 || status >= 500;
    throw new AppError("http_error", `${provider} returned HTTP ${status}`, {
      recoverable: retryable || status === 401 || status === 403 || status === 404,
      details: { provider, status, body: text.slice(0, 200) },
    });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const rec = asRecord(parsed);
    if (!rec) throw new Error("not an object");
    return rec;
  } catch {
    throw new AppError("bad_response", `${provider} returned a non-JSON body`, {
      recoverable: true,
      details: { provider, body: text.slice(0, 200) },
    });
  }
}

function extractContent(provider: Provider, body: Record<string, unknown>): string {
  const choices = body.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const message = asRecord(first?.message);
  const content = message?.content;
  let out = "";
  if (typeof content === "string") out = content;
  else if (Array.isArray(content)) {
    out = content.map((p) => (typeof p === "string" ? p : (asString(asRecord(p)?.text) ?? ""))).join("");
  }
  out = stripThinking(out);
  if (out.length === 0) {
    const finishReason = asString(first?.finish_reason);
    const cutOff = finishReason === "length";
    throw new AppError(
      "bad_response",
      `${provider} returned an empty answer${cutOff ? " (cut off by the token limit; raise maxTokens)" : ""}`,
      { recoverable: true, details: { provider, finish_reason: finishReason ?? null } },
    );
  }
  return out;
}

function finishReasonOf(body: Record<string, unknown>): string | undefined {
  const choices = body.choices;
  return asString(asRecord(Array.isArray(choices) ? choices[0] : undefined)?.finish_reason);
}

function extractUsage(body: Record<string, unknown>): GenerateResult["usage"] {
  const u = asRecord(body.usage);
  if (!u) return undefined;
  return {
    promptTokens: asNumber(u.prompt_tokens),
    completionTokens: asNumber(u.completion_tokens),
    totalTokens: asNumber(u.total_tokens),
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

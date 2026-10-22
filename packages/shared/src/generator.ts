import type { Config } from "./config.js";
import { AppError, toStructuredError, type StructuredError } from "./errors.js";
import { httpRequest, type FetchLike } from "./http.js";
import type { Secret } from "./secret.js";

/**
 * The generator seam. Agents and engines never call a model directly: they receive one
 * `Generator` function. Which provider answers is decided here, by configuration.
 *
 *   Nightshift (primary)  ->  Ollama (backup)  ->  fallback-rules (sample mode only)
 */

export type Lane = "default" | "fast" | "deep" | "judge";
export type Provider = "nightshift" | "ollama" | "fallback-rules";
export type RouteKind = "local" | "cloud";

export interface GenerateRequest {
  prompt: string;
  system?: string;
  /** Picks the Nightshift routing mode from config. Ignored if `model` is set. */
  lane?: Lane;
  /** Explicit model id or routing mode, e.g. "meterless/text.deep". */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  provider: Provider;
  /** What we asked for (a Nightshift routing mode or an Ollama model name). */
  requestedModel: string;
  /** What the runtime says actually answered (Nightshift: meterless.routed_model). */
  routedModel: string;
  /** "local" or "cloud" as reported by the runtime; null when it did not say. */
  routeKind: RouteKind | null;
  latencyMs: number;
  receiptId?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** Providers that failed before this one answered, in order. */
  fellBackFrom?: Array<{ provider: Provider; error: StructuredError }>;
}

export type Generator = (req: GenerateRequest) => Promise<GenerateResult>;

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
  fetchImpl?: FetchLike;
}

export function createNightshiftGenerator(opts: NightshiftOptions): Generator {
  return async (req) => {
    if (!opts.token) {
      throw new AppError("config_missing", "the Nightshift runtime token is not set", { recoverable: true });
    }
    const requestedModel = req.model ?? opts.models[req.lane ?? "default"];
    const { status, text, ms } = await httpRequest(joinUrl(opts.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token.reveal()}`,
        "meterless-app": opts.appId,
        "meterless-scope": opts.scope,
      },
      body: chatBody(requestedModel, req),
      timeoutMs: req.timeoutMs ?? opts.timeoutMs,
      signal: req.signal,
      fetchImpl: opts.fetchImpl,
    });
    const body = parseChatResponse("nightshift", status, text);
    const meterless = asRecord(body["meterless"]);
    const route = asRecord(meterless?.["winning_route"]);
    const kind = route?.["kind"];
    return {
      text: extractContent("nightshift", body),
      provider: "nightshift",
      requestedModel,
      routedModel: asString(meterless?.["routed_model"]) ?? asString(body["model"]) ?? requestedModel,
      routeKind: kind === "local" || kind === "cloud" ? kind : null,
      latencyMs: Math.round(ms),
      receiptId: asString(meterless?.["receipt_id"]),
      usage: extractUsage(body),
    };
  };
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export function createOllamaGenerator(opts: OllamaOptions): Generator {
  return async (req) => {
    const requestedModel = req.model ?? opts.model;
    const { status, text, ms } = await httpRequest(joinUrl(opts.baseUrl, "/chat/completions"), {
      method: "POST",
      body: chatBody(requestedModel, req),
      timeoutMs: req.timeoutMs ?? opts.timeoutMs,
      signal: req.signal,
      fetchImpl: opts.fetchImpl,
    });
    const body = parseChatResponse("ollama", status, text);
    return {
      text: extractContent("ollama", body),
      provider: "ollama",
      requestedModel,
      routedModel: asString(body["model"]) ?? requestedModel,
      routeKind: "local",
      latencyMs: Math.round(ms),
      usage: extractUsage(body),
    };
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
    };
  };
}

/** Try each generator in order. Only recoverable failures move on to the next one. */
export function createGeneratorChain(
  chain: NamedGenerator[],
  hooks: { onFallback?: (from: Provider, error: StructuredError) => void } = {},
): Generator {
  if (chain.length === 0) throw new Error("generator chain needs at least one provider");
  return async (req) => {
    const failures: Array<{ provider: Provider; error: StructuredError }> = [];
    for (const { provider, generate } of chain) {
      try {
        const result = await generate(req);
        return failures.length > 0 ? { ...result, fellBackFrom: failures } : result;
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const structured = toStructuredError(err);
        failures.push({ provider, error: structured });
        hooks.onFallback?.(provider, structured);
        if (!structured.recoverable) throw err;
      }
    }
    throw new AppError("http_error", "all model providers failed", {
      recoverable: true,
      details: { attempts: failures.map((f) => ({ provider: f.provider, type: f.error.type, message: f.error.message })) },
    });
  };
}

export interface BuildGeneratorDeps {
  fetchImpl?: FetchLike;
  /** Required to enable fallback-rules; only used when SAMPLE_MODE is on. */
  fallbackRules?: (req: GenerateRequest) => string;
  onFallback?: (from: Provider, error: StructuredError) => void;
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
        scope: nightshift.scope,
        models: nightshift.models,
        timeoutMs: nightshift.requestTimeoutMs,
        fetchImpl: deps.fetchImpl,
      }),
    },
    {
      provider: "ollama",
      generate: createOllamaGenerator({
        baseUrl: ollama.baseUrl,
        model: ollama.model,
        timeoutMs: ollama.requestTimeoutMs,
        fetchImpl: deps.fetchImpl,
      }),
    },
  ];
  if (cfg.sampleMode && deps.fallbackRules) {
    chain.push({ provider: "fallback-rules", generate: createFallbackRulesGenerator(deps.fallbackRules) });
  }
  return createGeneratorChain(chain, { onFallback: deps.onFallback });
}

/** Remove <think>...</think> reasoning blocks that some models put inside the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ---- helpers -------------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function chatBody(model: string, req: GenerateRequest): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });
  return {
    model,
    messages,
    stream: false,
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
  const choices = body["choices"];
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const message = asRecord(first?.["message"]);
  const content = message?.["content"];
  let out = "";
  if (typeof content === "string") out = content;
  else if (Array.isArray(content)) {
    out = content
      .map((p) => (typeof p === "string" ? p : asString(asRecord(p)?.["text"]) ?? ""))
      .join("");
  }
  out = stripThinking(out);
  if (out.length === 0) {
    throw new AppError("bad_response", `${provider} returned an empty answer`, { recoverable: true, details: { provider } });
  }
  return out;
}

function extractUsage(body: Record<string, unknown>): GenerateResult["usage"] {
  const u = asRecord(body["usage"]);
  if (!u) return undefined;
  return {
    promptTokens: asNumber(u["prompt_tokens"]),
    completionTokens: asNumber(u["completion_tokens"]),
    totalTokens: asNumber(u["total_tokens"]),
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

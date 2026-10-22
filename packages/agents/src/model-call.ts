import {
  type AgentName,
  AppError,
  type GenerateResult,
  type Generator,
  LANES,
  type Lane,
  type ModelUseInput,
  modelTraceFields,
  stripThinking,
} from "@sanctions-desk/shared";
import { z } from "zod";
import type { AgentDeps } from "./types.js";

/** A string a model may write too much of: kept, but cut to `max` characters instead of rejecting the answer. */
export const clipped = (max: number) =>
  z
    .string()
    .min(1)
    .transform((t) => (t.length > max ? `${t.slice(0, max - 1)}…` : t));

/** Pull the first complete JSON object out of a model answer (after removing reasoning blocks). */
export function extractJsonObject(text: string): unknown {
  const clean = stripThinking(text);
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end <= start) throw new AppError("bad_response", "the model answer has no JSON object");
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    throw new AppError("bad_response", "the model answer is not valid JSON");
  }
}

export interface AskJsonOptions<T extends z.ZodType> {
  agent: AgentName;
  system: string;
  prompt: string;
  schema: T;
  /** Added to the prompt on the second try, so the model can correct its own mistake. */
  maxAttempts?: number;
}

export interface AskJsonResult<T> {
  value: T;
  calls: ModelUseInput[];
}

const isLane = (value: string): value is Lane => (LANES as readonly string[]).includes(value);

export function modelUseOf(
  agent: AgentName,
  result: GenerateResult,
  thinking: ModelUseInput["thinking"],
): ModelUseInput {
  return {
    agent,
    model_requested: result.requestedModel,
    model_routed: result.routedModel,
    provider: result.provider,
    route_kind: result.routeKind,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(result.usage?.promptTokens !== undefined ? { tokens_in: result.usage.promptTokens } : {}),
    ...(result.usage?.completionTokens !== undefined ? { tokens_out: result.usage.completionTokens } : {}),
    latency_ms: result.latencyMs,
    ...(result.modeMismatch && result.servedMode !== undefined ? { served_mode: result.servedMode } : {}),
    ...(result.receipt ? { receipt: result.receipt } : {}),
  };
}

function problemOf(text: string, schema: z.ZodType): { value: unknown } | { problem: string } {
  try {
    const parsed = schema.safeParse(extractJsonObject(text));
    if (parsed.success) return { value: parsed.data };
    return {
      problem: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

interface Attempt {
  result: GenerateResult;
  outcome: ReturnType<typeof problemOf>;
}

async function attemptOnce<T extends z.ZodType>(
  deps: AgentDeps,
  options: AskJsonOptions<T>,
  prompt: string,
): Promise<Attempt> {
  const config = deps.policy.models[options.agent as keyof typeof deps.policy.models];
  const thinkingBudget = typeof config.thinking === "object" ? config.thinking.budgetTokens : 0;
  const result = await (deps.generator as Generator)({
    system: options.system,
    prompt,
    ...(isLane(config.model) ? { lane: config.model } : { model: config.model }),
    prefill: "{",
    temperature: 0,
    maxTokens: 1500 + thinkingBudget,
    timeoutMs: config.timeoutMs,
  });
  return { result, outcome: problemOf(result.text, options.schema) };
}

/** Ask the agent's configured model for one JSON object that matches `schema`. Tries again once on a bad answer. */
export async function askJson<T extends z.ZodType>(
  deps: AgentDeps,
  options: AskJsonOptions<T>,
): Promise<AskJsonResult<z.infer<T>>> {
  const config = deps.policy.models[options.agent as keyof typeof deps.policy.models];
  if (!config) throw new AppError("validation", `no model is configured for the ${options.agent} agent`);
  const attempts = options.maxAttempts ?? 2;
  const calls: ModelUseInput[] = [];
  let lastProblem = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryNote = `\n\nYour previous answer was rejected: ${lastProblem}\nAnswer again with one valid JSON object only.`;
    const { result, outcome } = await attemptOnce(
      deps,
      options,
      attempt === 1 ? options.prompt : options.prompt + retryNote,
    );
    calls.push(modelUseOf(options.agent, result, config.thinking));
    const ok = "value" in outcome;
    deps.trace.log({
      agent: options.agent,
      action: "model_answer",
      status: ok ? "ok" : attempt < attempts ? "retry" : "error",
      retry_count: attempt - 1,
      output_summary: ok ? `valid answer on attempt ${attempt}` : outcome.problem,
      ...modelTraceFields(result),
    });
    if (ok) return { value: outcome.value as z.infer<T>, calls };
    lastProblem = outcome.problem;
  }
  throw new AppError("bad_response", `the ${options.agent} model did not return a valid answer: ${lastProblem}`, {
    recoverable: true,
    details: { calls: calls.length },
  });
}

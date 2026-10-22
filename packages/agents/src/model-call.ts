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
  writeReceiptFile,
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

/**
 * For models that write their reasoning before the answer: the JSON object that ends the text. Each opening
 * brace is tried from the start until the rest of the text parses as one object, so braces inside the reasoning
 * are skipped and the whole answer (not an object nested inside it) is returned.
 */
export function extractLastJsonObject(text: string): unknown {
  const clean = stripThinking(text);
  const end = clean.lastIndexOf("}");
  for (let start = clean.indexOf("{"); start !== -1 && start < end; start = clean.indexOf("{", start + 1)) {
    try {
      const value: unknown = JSON.parse(clean.slice(start, end + 1));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // not the start of the answer; keep looking
    }
  }
  throw new AppError("bad_response", "the model answer has no JSON object");
}

export interface AskJsonOptions<T extends z.ZodType> {
  agent: AgentName;
  system: string;
  prompt: string;
  schema: T;
  /** Added to the prompt on the second try, so the model can correct its own mistake. */
  maxAttempts?: number;
  /** Force the fast path (no reasoning) even when the policy asks for reasoning, for easy cases. */
  fast?: boolean;
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
    const parsed = schema.safeParse(extractLastJsonObject(text));
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

/** Reasoning is bounded: the runtime gives up on a slow model after about 45 seconds. */
export const BRIEF_REASONING =
  "Keep any reasoning under 100 words, then give the JSON object. Put the JSON object last.";
const ANSWER_TOKENS = 700;

export function reasoningBudget(thinking: ModelUseInput["thinking"]): number {
  if (thinking === "on") return 500;
  return typeof thinking === "object" ? thinking.budgetTokens : 0;
}

async function attemptOnce<T extends z.ZodType>(
  deps: AgentDeps,
  options: AskJsonOptions<T>,
  prompt: string,
  reasoning: boolean,
): Promise<Attempt> {
  const config = deps.policy.models[options.agent as keyof typeof deps.policy.models];
  const budget = reasoningBudget(config.thinking);
  const result = await (deps.generator as Generator)({
    system: reasoning ? `${options.system}\n\n${BRIEF_REASONING}` : options.system,
    prompt,
    ...(isLane(config.model) ? { lane: config.model } : { model: config.model }),
    // Without reasoning the answer starts straight away with "{"; with it the model thinks first.
    ...(reasoning ? {} : { prefill: "{" }),
    temperature: 0,
    maxTokens: reasoning ? budget + ANSWER_TOKENS : 1500,
    timeoutMs: config.timeoutMs,
  });
  return { result, outcome: problemOf(result.text, options.schema) };
}

function logStep(
  deps: AgentDeps,
  agent: AgentName,
  step: { attempt: number; last: boolean; ok: boolean; summary: string; reasoning: boolean; result?: GenerateResult },
): void {
  const fields = step.result ? modelTraceFields(step.result) : {};
  deps.trace.log({
    agent,
    action: "model_answer",
    status: step.ok ? "ok" : step.last ? "error" : "retry",
    retry_count: step.attempt - 1,
    output_summary: step.summary.slice(0, 300),
    ...fields,
    detail: { ...(fields.detail ?? {}), reasoning: step.reasoning },
  });
}

type Round = { done: true; value: unknown } | { done: false; problem: string };

/** One round of asking: reasoning on the first try, the fast local path on the retry. */
async function askRound<T extends z.ZodType>(
  deps: AgentDeps,
  options: AskJsonOptions<T>,
  round: { attempt: number; attempts: number; previousProblem: string },
  calls: ModelUseInput[],
): Promise<Round> {
  const config = deps.policy.models[options.agent as keyof typeof deps.policy.models];
  const { attempt } = round;
  const last = attempt >= round.attempts;
  const reasoning = reasoningBudget(config.thinking) > 0 && attempt === 1 && options.fast !== true;
  const retryNote = `\n\nYour previous answer was rejected: ${round.previousProblem}\nAnswer again with one valid JSON object only.`;

  let tried: Attempt;
  try {
    tried = await attemptOnce(deps, options, attempt === 1 ? options.prompt : options.prompt + retryNote, reasoning);
  } catch (failure) {
    const problem = failure instanceof Error ? failure.message : String(failure);
    logStep(deps, options.agent, { attempt, last, ok: false, summary: `model call failed: ${problem}`, reasoning });
    if (last) throw failure;
    return { done: false, problem };
  }

  const { result, outcome } = tried;
  calls.push(modelUseOf(options.agent, result, reasoning ? config.thinking : "off"));
  // Keep the full signed receipt beside the trace, so anyone can verify it later.
  if (result.receipt && result.receiptEnvelope) {
    writeReceiptFile(deps.config.logging.dir, result.receipt.receipt_id, result.receiptEnvelope);
  }
  const ok = "value" in outcome;
  logStep(deps, options.agent, {
    attempt,
    last,
    ok,
    summary: ok ? `valid answer on attempt ${attempt}` : outcome.problem,
    reasoning,
    result,
  });
  return ok ? { done: true, value: outcome.value } : { done: false, problem: outcome.problem };
}

/** Ask the agent's configured model for one JSON object that matches `schema`. Tries again once on a bad answer. */
export async function askJson<T extends z.ZodType>(
  deps: AgentDeps,
  options: AskJsonOptions<T>,
): Promise<AskJsonResult<z.infer<T>>> {
  if (!deps.policy.models[options.agent as keyof typeof deps.policy.models]) {
    throw new AppError("validation", `no model is configured for the ${options.agent} agent`);
  }
  const attempts = options.maxAttempts ?? 2;
  const calls: ModelUseInput[] = [];
  let problem = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const round = await askRound(deps, options, { attempt, attempts, previousProblem: problem }, calls);
    if (round.done) return { value: round.value as z.infer<T>, calls };
    problem = round.problem;
  }
  throw new AppError("bad_response", `the ${options.agent} model did not return a valid answer: ${problem}`, {
    recoverable: true,
    details: { calls: calls.length },
  });
}

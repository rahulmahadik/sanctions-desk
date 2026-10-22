// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Runtime orchestrator. One function runs the whole chain: build the prompt, call the generator, clean the
// markers, account tokens, compress state, record the chunk and detect completion. A reflection failure
// never fails the run. Abort is checked before each chunk and before compression.

import type { CarryoverService } from "./carryover.js";
import { runEfficiency } from "./config-manager.js";
import { cleanMarkers, parseMarkers } from "./markers.js";
import type { ProgressService } from "./progress.js";
import { buildPrompt, overlapSlice } from "./prompt-builder.js";
import type { Attachment, ChunkConfig, ChunkInfo, Generator, MarkovianRun, Mode, RunOptions, StepFn } from "./types.js";
import { estimateTokens } from "./types.js";

let runSeq = 0;
export function resetRunSeq(): void {
  runSeq = 0;
}

export interface OrchestrateArgs {
  options: RunOptions;
  config: ChunkConfig;
  clock: () => number;
  progress: ProgressService;
  carryoverService: CarryoverService;
  defaultGenerator?: Generator;
}

interface Loop {
  carryover: string;
  previousCleaned: string;
  savings: number;
  done: boolean;
  parts: string[];
}

export async function orchestrate(args: OrchestrateArgs): Promise<MarkovianRun> {
  const { options, config, clock, progress } = args;
  const goal = options.goal ?? options.prompt;
  if (!goal) throw new Error("Markovian: run needs a goal or prompt");
  const mode: Mode = options.mode ?? "ARCHITECT";
  const generator = normalizeGenerator(options, args.defaultGenerator, goal);
  const start = clock();

  runSeq += 1;
  const run: MarkovianRun = {
    id: `run-${runSeq}`,
    timestamp: start,
    prompt: goal.slice(0, 500),
    mode,
    chunkConfig: { ...config },
    chunks: [],
    totalTokensUsed: 0,
    totalTokensSaved: 0,
    efficiencyPercent: 0,
    durationMs: 0,
    status: "completed",
    tokenLabel: "estimated",
    output: "",
  };
  const loop: Loop = { carryover: "", previousCleaned: "", savings: 0, done: false, parts: [] };

  progress.phase("initializing", `${mode} chain, maxChunks=${config.maxChunks}`);
  try {
    await runChain(args, { goal, mode, generator }, run, loop);
    if (!loop.done && run.status === "completed" && run.chunks.length >= config.maxChunks) run.status = "max-chunks";
  } catch (err) {
    run.status = "errored";
    run.error = (err as Error).message;
    progress.phase("error", run.error);
  }

  run.output = loop.parts.join("\n\n");
  const eff = runEfficiency(run.chunks, run.chunkConfig);
  run.totalTokensUsed = eff.totalTokensUsed;
  run.totalTokensSaved = eff.tokensSaved;
  run.efficiencyPercent = eff.efficiencyPercent;

  await reflect(args, generator, goal, run, loop.carryover);
  run.durationMs = clock() - start;
  progress.phase(run.status === "errored" ? "error" : "complete", run.status);
  return run;
}

async function runChain(
  args: OrchestrateArgs,
  ctx: { goal: string; mode: Mode; generator: Generator },
  run: MarkovianRun,
  loop: Loop,
): Promise<void> {
  const { options, config, progress, carryoverService } = args;
  const attachments: Attachment[] = options.attachments ?? [];

  while (run.chunks.length < config.maxChunks && !loop.done) {
    if (options.abortSignal?.aborted) {
      run.status = "aborted";
      return;
    }
    const step = run.chunks.length + 1;
    progress.phase("generating", `chunk ${step}`);
    const prompt = buildPrompt({
      mode: ctx.mode,
      goal: ctx.goal,
      step,
      carryover: loop.carryover,
      overlapText: overlapSlice(loop.previousCleaned, config),
      memoryContext: options.memoryContext,
      attachments: step === 1 ? attachments : [],
      config,
    });
    const { text } = await ctx.generator(
      prompt,
      step === 1 ? attachments : [],
      undefined,
      options.onStream,
      options.abortSignal,
    );
    const parsed = parseMarkers(text);
    const tokens = estimateTokens(parsed.cleaned);

    // Savings accounting (estimated, chars/4): re-reading the history versus carrying a fixed state.
    loop.savings += Math.max(0, (step - 1) * config.chunkSize + tokens - (config.carryoverTokens + tokens));

    // The chunk is stored first: its cost is already paid, so an abort after generation keeps the output.
    const chunk: ChunkInfo = { id: step, tokens, carryover: loop.carryover, content: parsed.cleaned };
    run.chunks.push(chunk);
    loop.parts.push(parsed.cleaned);
    loop.previousCleaned = parsed.cleaned;
    progress.chunkDone(chunk);

    if (options.abortSignal?.aborted) {
      run.status = "aborted";
      return;
    }
    progress.phase("compressing", `chunk ${step}`);
    const next = await carryoverService.next({
      markerState: parsed.state,
      previousCarryover: loop.carryover,
      chunkText: text,
      config,
    });
    loop.carryover = next.carryover;
    progress.update({
      tokensUsed: run.chunks.reduce((s, c) => s + c.tokens, 0),
      tokensSaved: loop.savings,
      carryoverSize: estimateTokens(loop.carryover),
    });
    loop.done = parsed.done || (options.stopWhen?.({ step, carryover: loop.carryover }) ?? false);
  }
}

/** Reflection runs only on completed, non-aborted runs with chunks. A failure is not fatal. */
async function reflect(
  args: OrchestrateArgs,
  generator: Generator,
  goal: string,
  run: MarkovianRun,
  carryover: string,
): Promise<void> {
  if (args.options.reflect === false || run.status !== "completed" || run.chunks.length === 0) return;
  args.progress.phase("reflecting");
  try {
    const codeBlocks = Math.floor((run.output.match(/```/g)?.length ?? 0) / 2);
    const prompt =
      `Reflect on this completed run.\nGoal: ${goal.slice(0, 200)}\nFinal state: ${carryover}\n` +
      `Output (truncated): ${run.output.slice(0, 4000)}\nCode blocks: ${codeBlocks}\n` +
      "Verdict: ratify if the goal is met, refine with concrete gaps otherwise.";
    const { text } = await generator(
      prompt,
      [],
      "You are the reflection pass. Be brief and concrete.",
      undefined,
      args.options.abortSignal,
    );
    run.reflection = cleanMarkers(text);
  } catch (err) {
    run.reflection = undefined;
    run.error = `reflection failed (run preserved): ${(err as Error).message}`;
  }
}

/** Adapt the simpler stepFn shape to the provider-agnostic generator contract. */
function normalizeGenerator(options: RunOptions, fallback: Generator | undefined, goal: string): Generator {
  if (options.generator) return options.generator;
  if (options.stepFn) {
    const stepFn: StepFn = options.stepFn;
    let step = 0;
    return async (prompt) => {
      const result = await stepFn({ goal, carryover: extractCarryoverFromPrompt(prompt), step, prompt });
      step += 1;
      return { text: result.content };
    };
  }
  if (fallback) return fallback;
  throw new Error("Markovian: provide a generator or stepFn");
}

function extractCarryoverFromPrompt(prompt: string): string {
  const m = prompt.match(/\[CARRYOVER STATE\]\n([\s\S]*?)(?:\n\n|$)/);
  return m ? (m[1] ?? "").trim() : "";
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  CarryoverService,
  type ChunkConfig,
  ConfigValidationError,
  canonicalBlock,
  cleanMarkers,
  DEFAULT_CONFIG,
  HistoryService,
  Markovian,
  type MarkovianRun,
  modelTotals,
  overlapSlice,
  ProgressService,
  parseMarkers,
  projectionCurve,
  resetRunSeq,
  resolveConfig,
  runEfficiency,
} from "../src/markovian/index.js";

const T0 = 1_750_000_000_000;
const CONFIG: ChunkConfig = { chunkSize: 4000, maxChunks: 6, carryoverTokens: 640, overlapTokens: 0 };

function steps(total: number, state = "COMPLETED: earlier steps recorded in the carried state block") {
  let calls = 0;
  const generate = async () => {
    calls += 1;
    const body = `Output for step ${calls} with enough text to register in the accounting math. `.repeat(10);
    return { text: `${body}\n${calls >= total ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\n${state}`}` };
  };
  return { generate, calls: () => calls };
}

describe("markers", () => {
  it("reads state, completion, progress, tool and clarification requests", () => {
    const parsed = parseMarkers(
      'Intro <PROGRESS>half way</PROGRESS> <NEEDS_TOOL tool="search" input="aml" /> <NEEDS_CLARIFICATION> which list?\n[STATE_CHECKPOINT]\nCOMPLETED: a',
    );
    expect(parsed).toMatchObject({
      state: "COMPLETED: a",
      done: false,
      progress: "half way",
      needsTool: { tool: "search", input: "aml" },
      needsClarification: "which list?",
    });
    expect(parsed.cleaned).toBe("Intro");
  });

  it("accepts the alternative forms and cleans every one", () => {
    expect(parseMarkers("x <CARRYOVER>kept state</CARRYOVER> <DONE/>")).toMatchObject({
      state: "kept state",
      done: true,
    });
    expect(parseMarkers("x\n@@@STATE@@@ s1").state).toBe("s1");
    expect(parseMarkers("x\n---STATE--- s2").state).toBe("s2");
    expect(parseMarkers("x\n[STATE] s3").state).toBe("s3");
    expect(parseMarkers("y @@@FINAL@@@").done).toBe(true);
    expect(parseMarkers("y ---FINAL---").done).toBe(true);
    expect(parseMarkers("y\n[FINAL]").done).toBe(true);
    expect(parseMarkers("plain text").state).toBeUndefined();
    expect(cleanMarkers("a\n[FINAL]\nb")).toBe("a");
    expect(cleanMarkers("a @@@STATE@@@ s\n\n\n\nb")).toBe("a");
    expect(cleanMarkers("mid [STATE] inline stays")).toBe("mid [STATE] inline stays");
    expect(parseMarkers("t <NEEDS_TOOL tool=\"x\" input='y'>").needsTool).toEqual({ tool: "x", input: "y" });
  });
});

describe("configuration", () => {
  it("fills defaults and rejects values outside the bounds with a typed error", () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
    expect(() => resolveConfig({ chunkSize: 128 })).toThrow(ConfigValidationError);
    expect(() => resolveConfig({ maxChunks: 99 })).toThrow(/outside/);
    expect(() => resolveConfig({ carryoverTokens: Number.NaN })).toThrow(/must be a number/);
    expect(() => resolveConfig({ chunkSize: 1000, carryoverTokens: 800 })).toThrow(/framing/);
  });

  it("projects the curves and the documented worked example", () => {
    const curve = projectionCurve(CONFIG, 3);
    expect(curve[2]).toEqual({ step: 3, standard: 12000, markovian: 4640 });
    const { naiveTotal, markovianTotal, efficiency } = modelTotals(20);
    expect([naiveTotal, markovianTotal]).toEqual([246000, 34000]);
    expect(efficiency).toBeCloseTo(0.8618, 3);
    expect(runEfficiency([], CONFIG).efficiencyPercent).toBe(0);
  });
});

describe("carryover cascade", () => {
  const service = (compress?: (p: string, s: string) => Promise<string>) => new CarryoverService(compress);
  const base = { previousCarryover: "prev state", chunkText: "text", config: CONFIG };

  it("uses the marker state when it is long enough and within budget", async () => {
    const out = await service().next({ ...base, markerState: "COMPLETED: step one, REMAINING: step two" });
    expect(out.level).toBe("marker");
  });

  it("falls to model compression, then to key phrases, then to the tail", async () => {
    const compressed = await service(async () => "COMPLETED: a\nREMAINING: b\nDECISIONS: c\nCONTEXT: d").next({
      ...base,
      markerState: "short",
    });
    expect(compressed.level).toBe("llm");

    const failing = await service(async () => {
      throw new Error("down");
    }).next({ ...base, markerState: undefined, chunkText: "Status: ledger reconciled. Next: second pass" });
    expect(failing.level).toBe("heuristic");
    expect(failing.carryover).toContain("Status: ledger reconciled");

    const tooLong = await service(async () => "x".repeat(10_000)).next({
      ...base,
      markerState: undefined,
      chunkText: "plain words only with no key phrases at all in this text",
    });
    expect(tooLong.level).toBe("truncation");

    const tail = await service().next({
      ...base,
      markerState: undefined,
      chunkText: `${"word ".repeat(2000)}the end`,
    });
    expect(tail.level).toBe("truncation");
    expect(tail.carryover.endsWith("the end")).toBe(true);
    expect(tail.carryover.length).toBeLessThanOrEqual(640 * 4);
    expect((await service().next({ ...base, markerState: undefined, chunkText: "" })).carryover).toBe("prev state");
    expect(canonicalBlock({ completed: "a", remaining: "b", decisions: "c", context: "d" })).toBe(
      "COMPLETED: a\nREMAINING: b\nDECISIONS: c\nCONTEXT: d",
    );
  });

  it("rejects a marker state that is too long for the budget", async () => {
    const out = await service().next({
      ...base,
      markerState: "COMPLETED ".repeat(500),
      config: { ...CONFIG, carryoverTokens: 128 },
    });
    expect(out.level).not.toBe("marker");
  });
});

describe("prompts", () => {
  const args = {
    mode: "ARCHITECT" as const,
    goal: "Build it",
    step: 1,
    carryover: "",
    overlapText: "",
    attachments: [],
    config: CONFIG,
  };

  it("puts memory context and attachments in the first chunk only", () => {
    const first = buildPrompt({ ...args, memoryContext: "[MEMORY]", attachments: [{ name: "a.md", content: "A" }] });
    expect(first).toContain("[MEMORY]");
    expect(first).toContain("[ATTACHMENT a.md]");
    expect(first).toContain("User Request: Build it");
    const second = buildPrompt({
      ...args,
      step: 2,
      carryover: "STATE",
      overlapText: "tail",
      memoryContext: "[MEMORY]",
    });
    expect(second).toContain("[CARRYOVER STATE]\nSTATE");
    expect(second).toContain("[OVERLAP]\ntail");
    expect(second).not.toContain("[MEMORY]");
    expect(buildPrompt({ ...args, mode: "RESEARCH" })).toContain("recursive research");
    expect(buildPrompt({ ...args, step: 2, carryover: "S" })).not.toContain("[OVERLAP]");
  });

  it("slices the overlap from the end of the previous output", () => {
    expect(overlapSlice("abcdefghij", { ...CONFIG, overlapTokens: 1 })).toBe("ghij");
    expect(overlapSlice("abc", CONFIG)).toBe("");
    expect(overlapSlice("", { ...CONFIG, overlapTokens: 5 })).toBe("");
  });
});

describe("running a chain", () => {
  it("runs to completion, cleans the output, snapshots the configuration and reports progress", async () => {
    resetRunSeq();
    const m = new Markovian({ chunkConfig: CONFIG, clock: () => T0 });
    const phases: string[] = [];
    const stop = m.onProgress((s) => phases.push(s.phase));
    const gen = steps(3);
    const run = await m.run({ goal: "three steps", generator: gen.generate, reflect: false });
    stop();
    expect(run).toMatchObject({ id: "run-1", status: "completed", tokenLabel: "estimated", mode: "ARCHITECT" });
    expect(run.chunks).toHaveLength(3);
    expect(run.chunks[1]?.carryover).toContain("COMPLETED");
    expect(run.output).not.toMatch(/STATE_CHECKPOINT|TASK_COMPLETE/);
    expect(run.chunkConfig).toEqual(CONFIG);
    expect(run.totalTokensSaved).toBeGreaterThanOrEqual(0);
    expect(new Set(phases)).toEqual(new Set(["initializing", "generating", "compressing", "complete"]));
    expect(m.progress.get().logs.length).toBeLessThanOrEqual(15);
    expect(m.history.list()).toHaveLength(1);
  });

  it("stops at the chunk limit, on stopWhen, on abort and on a generator failure", async () => {
    const endless = async () => ({ text: "still going [STATE_CHECKPOINT] COMPLETED: not finished yet, carrying on" });
    const limited = await new Markovian({ chunkConfig: { ...CONFIG, maxChunks: 2 }, clock: () => T0 }).run({
      goal: "endless",
      generator: endless,
      reflect: false,
    });
    expect(limited.status).toBe("max-chunks");

    const stopped = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      goal: "stop early",
      generator: endless,
      reflect: false,
      stopWhen: ({ step }) => step === 2,
    });
    expect(stopped.status).toBe("completed");
    expect(stopped.chunks).toHaveLength(2);

    const controller = new AbortController();
    const abortedBefore = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      goal: "abort",
      generator: async () => {
        controller.abort();
        return { text: "one chunk [STATE_CHECKPOINT] COMPLETED: after the abort the chunk is kept" };
      },
      abortSignal: controller.signal,
      reflect: false,
    });
    expect(abortedBefore.status).toBe("aborted");
    expect(abortedBefore.chunks).toHaveLength(1);

    const pre = new AbortController();
    pre.abort();
    const never = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      goal: "x",
      generator: endless,
      abortSignal: pre.signal,
    });
    expect(never).toMatchObject({ status: "aborted", chunks: [] });

    const broken = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      goal: "fail",
      generator: async () => {
        throw new Error("provider down");
      },
    });
    expect(broken).toMatchObject({ status: "errored", error: "provider down" });
  });

  it("reflects on a completed run and survives a reflection failure", async () => {
    const reflected = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      goal: "reflect",
      generator: async (prompt) => ({
        text: prompt.startsWith("Reflect") ? "Ratified. [TASK_COMPLETE]" : "done [TASK_COMPLETE]",
      }),
    });
    expect(reflected.reflection).toBe("Ratified.");
    const failed = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      goal: "reflect",
      generator: (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n === 2) throw new Error("reflection exploded");
          return { text: "done [TASK_COMPLETE]" };
        };
      })(),
    });
    expect(failed.status).toBe("completed");
    expect(failed.error).toContain("reflection failed");
  });

  it("accepts a stepFn, a default generator, memory context and a compressor", async () => {
    const seenCarry: string[] = [];
    const viaStep = await new Markovian({ chunkConfig: CONFIG, clock: () => T0 }).run({
      prompt: "via step function",
      mode: "RESEARCH",
      reflect: false,
      stepFn: ({ carryover, step }) => {
        seenCarry.push(carryover);
        return {
          content:
            step >= 1 ? "end [TASK_COMPLETE]" : "go [STATE_CHECKPOINT] COMPLETED: one chunk is done and recorded",
        };
      },
    });
    expect(viaStep.chunks.length).toBeGreaterThanOrEqual(1);
    expect(viaStep.mode).toBe("RESEARCH");

    const prompts: string[] = [];
    const withDefault = new Markovian({
      chunkConfig: CONFIG,
      clock: () => T0,
      generator: async (p) => {
        prompts.push(p);
        return { text: "x [TASK_COMPLETE]" };
      },
      compressorFn: async () => "COMPLETED: a\nREMAINING: b\nDECISIONS: c\nCONTEXT: d",
    });
    await withDefault.run({ goal: "g", memoryContext: "[MEMORY CONTEXT]", reflect: false });
    expect(prompts[0]).toContain("[MEMORY CONTEXT]");

    await expect(new Markovian({ clock: () => T0 }).run({ goal: "g" })).rejects.toThrow(/generator or stepFn/);
    await expect(new Markovian({ clock: () => T0 }).run({})).rejects.toThrow(/goal or prompt/);
  });

  it("implements the overlap window when it is configured", async () => {
    const prompts: string[] = [];
    const m = new Markovian({ chunkConfig: { ...CONFIG, overlapTokens: 16 }, clock: () => T0 });
    const gen = steps(2);
    await m.run({
      goal: "overlap",
      generator: async (p) => {
        prompts.push(p);
        return gen.generate();
      },
      reflect: false,
    });
    expect(prompts[1]).toContain("[OVERLAP]");
  });
});

describe("history", () => {
  const fakeRun = (id: string, config: ChunkConfig, tokens: number[]): MarkovianRun => ({
    id,
    timestamp: T0,
    prompt: "p",
    mode: "ARCHITECT",
    chunkConfig: config,
    chunks: tokens.map((t, i) => ({ id: i + 1, tokens: t, carryover: "", content: "" })),
    totalTokensUsed: 0,
    totalTokensSaved: 0,
    efficiencyPercent: 0,
    durationMs: 0,
    status: "completed",
    tokenLabel: "estimated",
    output: "",
  });

  it("recomputes efficiency from each run's own snapshot and aggregates per step", () => {
    const history = new HistoryService();
    let notified = 0;
    const stop = history.subscribe(() => {
      notified += 1;
    });
    history.record(fakeRun("a", { ...CONFIG, carryoverTokens: 512 }, [1000, 1000, 1000, 1000]));
    history.record(fakeRun("b", { ...CONFIG, carryoverTokens: 2048 }, [1000, 1000]));
    stop();
    const stats = history.cumulativeStats();
    expect(stats).toMatchObject({ totalRuns: 2, completedRuns: 2, totalChunksProcessed: 6, totalTokensUsed: 6000 });
    expect(stats.efficiencyHistory[0]?.tokensSaved).not.toBe(stats.efficiencyHistory[1]?.tokensSaved);
    expect(history.performanceByStep()[0]).toEqual({ step: 1, avgTokens: 1000, samples: 2 });
    expect(notified).toBe(2);
    expect(history.get("a")?.id).toBe("a");
    history.delete("a");
    expect(history.list()).toHaveLength(1);
    history.clear();
    expect(history.cumulativeStats().averageEfficiency).toBe(0);
    expect(() => history.record({ ...fakeRun("c", CONFIG, [1]), chunkConfig: undefined as never })).toThrow(/snapshot/);
  });

  it("persists runs to disk and loads them again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markovian-"));
    const a = new Markovian({ chunkConfig: CONFIG, clock: () => T0, historyDir: dir });
    await a.run({ goal: "persist", generator: async () => ({ text: "done [TASK_COMPLETE]" }), reflect: false });
    const b = new HistoryService(dir);
    expect(b.list()).toHaveLength(1);
  });
});

describe("progress", () => {
  it("keeps only the last 15 log lines and notifies subscribers", () => {
    let now = 0;
    const progress = new ProgressService(() => now++, 4);
    let updates = 0;
    progress.subscribe(() => {
      updates += 1;
    });
    for (let i = 0; i < 20; i += 1) progress.update({ tokensUsed: i }, `line ${i}`);
    expect(progress.get().logs).toHaveLength(15);
    expect(progress.get().logs[0]).toBe("line 5");
    expect(updates).toBe(20);
  });
});

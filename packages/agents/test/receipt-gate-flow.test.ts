import {
  AppError,
  type GenerateResult,
  type Generator,
  type ReceiptVerification,
  readTrace,
} from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askJson, unavailableCause } from "../src/index.js";
import { sampleDeps, scriptedGenerator } from "./helpers.js";

/**
 * The receipt gate inside the ask loop: a Nightshift answer with no receipt, or one signed by another key, is retried
 * like any unusable answer and the trace says why; the number of tries, the fast path and what is kept of a failed
 * answer are each the step's own business.
 */
const receipt = (verification: ReceiptVerification) => ({
  receipt_id: "r-1",
  pubkey_b64: "AAAA",
  sig_b64: "AAAA",
  body_hash: "a".repeat(64),
  verification,
});
const answer = (text: string, over: Partial<GenerateResult> = {}): GenerateResult => ({
  text,
  provider: "nightshift",
  requestedModel: "meterless/deep",
  routedModel: "nvidia/nemotron-3-ultra-550b-a55b",
  routeKind: "cloud",
  latencyMs: 1,
  modeMismatch: false,
  ...over,
});
const OK = JSON.stringify({ value: 1 });
const options = { agent: "decision" as const, system: "s", prompt: "p", schema: z.object({ value: z.number() }) };
const fromList =
  (replies: GenerateResult[]): Generator =>
  async () =>
    replies.shift() as GenerateResult;
const modelAnswers = (file: string) => readTrace(file).filter((e) => e.action === "model_answer");

describe("a Nightshift answer without a usable receipt", () => {
  it.each<[string, ReturnType<typeof receipt> | undefined, string]>([
    ["no receipt at all", undefined, "receipt missing"],
    ["a receipt signed by another key", receipt("valid_unpinned"), "receipt not signed by the pinned key"],
  ])("is not used when it has %s: the step retries and the trace names the problem", async (_name, r, problem) => {
    const replies = [answer(OK, { receipt: r }), answer(OK, { receipt: receipt("valid_pinned") })];
    const deps = sampleDeps({ generator: fromList(replies) });
    const out = await askJson(deps, options);
    expect(out.value).toEqual({ value: 1 });
    expect(out.route).toBe("fast");
    expect(out.calls.map((c) => c.receipt_rejected)).toEqual([problem, undefined]);
    const steps = modelAnswers(deps.trace.file);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      status: "retry",
      retry_count: 0,
      output_summary: `answer not used: ${problem}`,
      detail: { receipt_rejected: problem, route: "own" },
    });
    expect(steps[1]).toMatchObject({ status: "ok", retry_count: 1, detail: { route: "fast" } });
    expect(steps[1]?.detail).not.toHaveProperty("receipt_rejected");
  });

  it("names the receipt problem before any fault in the answer itself", async () => {
    const replies = [
      answer("not json", { receipt: receipt("invalid") }),
      answer(OK, { receipt: receipt("valid_pinned") }),
    ];
    const deps = sampleDeps({ generator: fromList(replies) });
    const out = await askJson(deps, options);
    expect(out.value).toEqual({ value: 1 });
    expect(modelAnswers(deps.trace.file)[0]?.output_summary).toBe("answer not used: receipt invalid");
  });

  it("gives up with a structured error that names the receipt problem when no try has a usable receipt", async () => {
    const deps = sampleDeps({ generator: async () => answer(OK, { receipt: receipt("invalid") }) });
    const err = (await askJson(deps, options).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.type).toBe("bad_response");
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain("answer not used: receipt invalid");
    expect(err.details).toEqual({ calls: 3 });
    const steps = modelAnswers(deps.trace.file);
    expect(steps.map((s) => s.status)).toEqual(["retry", "retry", "error"]);
    for (const s of steps) expect(s.detail).toMatchObject({ receipt_rejected: "receipt invalid" });
    // The last try asked the backup provider; the gate still applies to what came back labelled as Nightshift.
    expect(steps[2]?.detail).toMatchObject({ route: "backup", lane: "ollama" });
  });
});

describe("how many tries a step gets", () => {
  it("stops after the tries asked for, and reaches the backup provider only on a third try", async () => {
    const { generator, requests } = scriptedGenerator(["no", "still no"]);
    await expect(askJson(sampleDeps({ generator }), { ...options, maxAttempts: 2 })).rejects.toMatchObject({
      type: "bad_response",
      details: { calls: 2 },
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.provider)).toEqual([undefined, undefined]);
    expect(requests[1]).toMatchObject({ lane: "fast", prefill: "{" });
  });

  it("makes one try only when asked for one", async () => {
    const { generator, requests } = scriptedGenerator(["no"]);
    await expect(askJson(sampleDeps({ generator }), { ...options, maxAttempts: 1 })).rejects.toMatchObject({
      type: "bad_response",
      details: { calls: 1 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.lane).toBe("deep");
  });

  it("skips the reasoning when the step asks for the fast path, on the step's own lane", async () => {
    const { generator, requests } = scriptedGenerator([OK]);
    const out = await askJson(sampleDeps({ generator }), { ...options, fast: true });
    expect(requests[0]).toMatchObject({ lane: "deep", prefill: "{", maxTokens: 1500, system: "s" });
    expect(out.calls[0]?.thinking).toBe("off");
    expect(out.route).toBe("own");
  });
});

describe("what a model call records", () => {
  it("keeps the tokens, the app identity, the receipt, and the served mode only when it differs from the one asked for", async () => {
    const served = answer(OK, {
      receipt: receipt("valid_pinned"),
      usage: { promptTokens: 12, completionTokens: 3 },
      app: "sanctions-desk-reasoning",
      servedMode: "meterless/fast",
      modeMismatch: true,
    });
    const out = await askJson(sampleDeps({ generator: async () => served }), options);
    expect(out.calls[0]).toMatchObject({
      tokens_in: 12,
      tokens_out: 3,
      app: "sanctions-desk-reasoning",
      served_mode: "meterless/fast",
      receipt: { receipt_id: "r-1", verification: "valid_pinned" },
    });
    expect(out.calls[0]).not.toHaveProperty("receipt_rejected");

    const asAsked = answer(OK, { receipt: receipt("valid_pinned"), servedMode: "meterless/deep", modeMismatch: false });
    const same = await askJson(sampleDeps({ generator: async () => asAsked }), options);
    expect(same.calls[0]).not.toHaveProperty("served_mode");
    expect(same.calls[0]).not.toHaveProperty("tokens_in");
    expect(same.calls[0]).not.toHaveProperty("app");
  });

  it.each(["screener", "policy_guard"] as const)(
    "keeps no excerpt of a failed answer from the %s step, which reads the customer's own text",
    async (agent) => {
      const bad = "this is not the JSON that was asked for";
      const { generator } = scriptedGenerator([bad, OK]);
      const deps = sampleDeps({ generator });
      await askJson(deps, { ...options, agent });
      const failed = modelAnswers(deps.trace.file).find((e) => e.status !== "ok");
      expect(failed?.detail).toMatchObject({ finish_reason: null, answer_chars: bad.length });
      expect(failed?.detail).not.toHaveProperty("answer_head");
      expect(failed?.detail).not.toHaveProperty("answer_tail");
    },
  );

  it("keeps the start and the end of a failed answer from the decision step", async () => {
    const { generator } = scriptedGenerator([`${"x".repeat(300)} and then it stopped`, OK]);
    const deps = sampleDeps({ generator });
    await askJson(deps, options);
    const failed = modelAnswers(deps.trace.file).find((e) => e.status !== "ok");
    expect(failed?.detail).toMatchObject({ answer_chars: 320, answer_head: "x".repeat(200) });
    expect(String(failed?.detail?.answer_tail)).toContain("and then it stopped");
  });
});

describe("why no usable answer came back", () => {
  it("calls a prompt that was never sent withheld, a dead or slow route a provider failure, and the rest parsing", () => {
    expect(unavailableCause(new AppError("guard_blocked", "free text of the case is in the prompt"))).toBe("withheld");
    expect(unavailableCause(new AppError("timeout", "no first token in time"))).toBe("provider");
    expect(unavailableCause(new AppError("route_dead", "the mode is retired"))).toBe("provider");
    expect(unavailableCause(new AppError("bad_response", "the decision model did not return a valid answer"))).toBe(
      "parsing",
    );
  });
});

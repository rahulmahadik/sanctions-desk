import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askJson, clipped, extractJsonObject, extractLastJsonObject, reasoningBudget } from "../src/model-call.js";
import { sampleDeps, scriptedGenerator } from "./helpers.js";

describe("extractJsonObject", () => {
  it("finds the object after reasoning blocks and surrounding text", () => {
    expect(extractJsonObject('<think>hmm {not json}</think>\nHere: {"a": 1} done')).toEqual({ a: 1 });
  });
  it("rejects text with no object or a broken one", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
    expect(() => extractJsonObject("{broken")).toThrow(/no JSON object/);
    expect(() => extractJsonObject("{a: 1}")).toThrow(/not valid JSON/);
  });
});

describe("extractLastJsonObject", () => {
  it("skips braces in the reasoning and returns the last object", () => {
    expect(extractLastJsonObject('think {a} then {"k": {"n": 1}}')).toEqual({ k: { n: 1 } });
    expect(extractLastJsonObject('{"only": true}')).toEqual({ only: true });
  });
  it("fails when there is no parsable object", () => {
    expect(() => extractLastJsonObject("nothing {broken")).toThrow(/no JSON object/);
    expect(() => extractLastJsonObject("plain")).toThrow(/no JSON object/);
  });
});

describe("reasoningBudget", () => {
  it("reads off, on and an explicit budget", () => {
    expect(reasoningBudget("off")).toBe(0);
    expect(reasoningBudget("on")).toBe(500);
    expect(reasoningBudget({ budgetTokens: 300 })).toBe(300);
    expect(reasoningBudget(undefined)).toBe(0);
  });
});

describe("clipped", () => {
  it("cuts long text instead of rejecting it", () => {
    const out = z.object({ t: clipped(10) }).parse({ t: "x".repeat(50) });
    expect(out.t).toHaveLength(10);
    expect(out.t.endsWith("…")).toBe(true);
    expect(() => z.object({ t: clipped(10) }).parse({ t: "" })).toThrow();
  });
});

describe("askJson", () => {
  const schema = z.object({ decision: z.string(), confidence: z.number() });
  const ask = (deps: ReturnType<typeof sampleDeps>) =>
    askJson(deps, { agent: "decision", system: "s", prompt: "p", schema });

  it("lets a reasoning agent think briefly first: no prefill, a bounded budget, the answer is the last JSON object", async () => {
    const { generator, requests } = scriptedGenerator([
      'Thinking {briefly} about it. {"decision": "X", "confidence": 0.5}',
    ]);
    const out = await ask(sampleDeps({ generator }));
    expect(out.value).toEqual({ decision: "X", confidence: 0.5 });
    expect(requests[0]).toMatchObject({ lane: "deep", temperature: 0, prompt: "p", maxTokens: 500 + 700 });
    expect(requests[0]?.prefill).toBeUndefined();
    expect(requests[0]?.system).toContain("Keep any reasoning under 100 words");
    expect(out.calls[0]).toMatchObject({
      agent: "decision",
      provider: "fallback-rules",
      route_kind: "local",
      thinking: { budgetTokens: 500 },
    });
  });

  it("answers straight away with a JSON prefill when reasoning is off", async () => {
    const base = sampleDeps();
    const policy = {
      ...base.policy,
      models: { ...base.policy.models, decision: { ...base.policy.models.decision, thinking: "off" as const } },
    };
    const { generator, requests } = scriptedGenerator(['{"decision": "X", "confidence": 0.5}']);
    const out = await ask(sampleDeps({ generator, policy }));
    expect(requests[0]).toMatchObject({ lane: "deep", prefill: "{", maxTokens: 1500 });
    expect(requests[0]?.system).toBe("s");
    expect(out.calls[0]?.thinking).toBe("off");
  });

  it("falls back to the fast path with a prefill when the reasoning call fails", async () => {
    const { generator, requests } = scriptedGenerator([
      new Error("nightshift returned HTTP 502"),
      '{"decision": "Y", "confidence": 1}',
    ]);
    const out = await ask(sampleDeps({ generator }));
    expect(out.value.decision).toBe("Y");
    expect(requests[0]?.prefill).toBeUndefined();
    expect(requests[1]).toMatchObject({ lane: "fast", prefill: "{", maxTokens: 1500 });
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]?.thinking).toBe("off");
  });

  it("raises the error when every attempt fails to get an answer at all", async () => {
    const { generator } = scriptedGenerator([new Error("down")]);
    await expect(ask(sampleDeps({ generator }))).rejects.toThrow("down");
  });

  it("tries once more with the problem named, then succeeds", async () => {
    const { generator, requests } = scriptedGenerator(["not json at all", '{"decision": "Y", "confidence": 1}']);
    const out = await ask(sampleDeps({ generator }));
    expect(out.value.decision).toBe("Y");
    expect(out.calls).toHaveLength(2);
    expect(requests[1]?.prompt).toContain("previous answer was rejected");
    expect(requests[1]?.prefill).toBe("{");
  });

  it("makes the last try on the backup provider", async () => {
    const { generator, requests } = scriptedGenerator(["no", "still no", '{"decision": "Y", "confidence": 1}']);
    const out = await ask(sampleDeps({ generator }));
    expect(out.value.decision).toBe("Y");
    expect(requests.map((r) => r.provider)).toEqual([undefined, undefined, "ollama"]);
    expect(requests[1]).toMatchObject({ lane: "fast", prefill: "{" });
  });

  it("fails with a structured error after the allowed attempts", async () => {
    const { generator } = scriptedGenerator(['{"decision": 5}']);
    await expect(ask(sampleDeps({ generator }))).rejects.toMatchObject({ type: "bad_response", recoverable: true });
  });

  it("uses a pinned mode when the policy names one instead of a lane", async () => {
    const base = sampleDeps();
    const policy = {
      ...base.policy,
      models: { ...base.policy.models, decision: { ...base.policy.models.decision, model: "meterless/text.deep" } },
    };
    const { generator, requests } = scriptedGenerator(['{"decision": "Z", "confidence": 0}']);
    await ask(sampleDeps({ generator, policy }));
    expect(requests[0]).toMatchObject({ model: "meterless/text.deep" });
    expect(requests[0]?.lane).toBeUndefined();
  });

  it("rejects an agent with no configured model", async () => {
    await expect(askJson(sampleDeps(), { agent: "human", system: "s", prompt: "p", schema })).rejects.toMatchObject({
      type: "validation",
    });
  });
});

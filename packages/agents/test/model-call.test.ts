import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askJson, clipped, extractJsonObject } from "../src/model-call.js";
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

  it("sends the agent's configured lane with a JSON prefill and returns the model ledger entry", async () => {
    const { generator, requests } = scriptedGenerator(['{"decision": "X", "confidence": 0.5}']);
    const out = await ask(sampleDeps({ generator }));
    expect(out.value).toEqual({ decision: "X", confidence: 0.5 });
    expect(requests[0]).toMatchObject({ lane: "deep", prefill: "{", temperature: 0, system: "s", prompt: "p" });
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({
      agent: "decision",
      provider: "fallback-rules",
      route_kind: "local",
      thinking: { budgetTokens: 4096 },
    });
  });

  it("tries once more with the problem named, then succeeds", async () => {
    const { generator, requests } = scriptedGenerator(["not json at all", '{"decision": "Y", "confidence": 1}']);
    const out = await ask(sampleDeps({ generator }));
    expect(out.value.decision).toBe("Y");
    expect(out.calls).toHaveLength(2);
    expect(requests[1]?.prompt).toContain("previous answer was rejected");
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

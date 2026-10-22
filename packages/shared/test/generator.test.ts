import { describe, expect, it } from "vitest";
import {
  AppError,
  buildGenerator,
  createFallbackRulesGenerator,
  createGeneratorChain,
  createNightshiftGenerator,
  createOllamaGenerator,
  type Provider,
  Secret,
  type StructuredError,
  stripThinking,
} from "../src/index.js";
import { chatReply, jsonResponse, stubFetch, testConfig } from "./helpers.js";

const TOKEN = "rt-test-token-0123456789";
const models = { default: "m/auto", fast: "m/fast", deep: "m/deep", judge: "m/judge" };

function nightshift(responses: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(responses);
  const generate = createNightshiftGenerator({
    baseUrl: "http://nightshift.test/v1/",
    token: new Secret(TOKEN),
    appId: "test-app",
    scope: "user",
    models,
    timeoutMs: 1000,
    fetchImpl: stub.fetchImpl,
  });
  return { generate, calls: stub.calls };
}

describe("Nightshift generator", () => {
  it("sends auth and app headers, picks the lane model and records the route", async () => {
    const { generate, calls } = nightshift([
      jsonResponse(
        chatReply("ready", {
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          meterless: {
            requested_model: "m/fast",
            routed_model: "local-runtime/nemotron",
            receipt_id: "rcpt_1",
            winning_route: { kind: "local" },
          },
        }),
      ),
    ]);
    const result = await generate({ prompt: "hi", system: "be brief", lane: "fast", temperature: 0, maxTokens: 20 });

    expect(result).toMatchObject({
      text: "ready",
      provider: "nightshift",
      requestedModel: "m/fast",
      routedModel: "local-runtime/nemotron",
      routeKind: "local",
      receiptId: "rcpt_1",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    const call = calls[0];
    expect(call?.url).toBe("http://nightshift.test/v1/chat/completions");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["meterless-app"]).toBe("test-app");
    expect(headers["meterless-scope"]).toBe("user");
    const body = JSON.parse(String(call?.init.body));
    expect(body).toMatchObject({ model: "m/fast", stream: false, temperature: 0, max_tokens: 20 });
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("lets an explicit model override the lane, and reports unknown routes as null", async () => {
    const { generate, calls } = nightshift([jsonResponse(chatReply("ok"))]);
    const result = await generate({ prompt: "x", lane: "deep", model: "meterless/text.deep" });
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe("meterless/text.deep");
    expect(result.routeKind).toBeNull();
    expect(result.routedModel).toBe("answering-model");
  });

  it("fails with a recoverable config error when no token is set", async () => {
    const generate = createNightshiftGenerator({
      baseUrl: "http://nightshift.test/v1",
      appId: "a",
      scope: "user",
      models,
      timeoutMs: 1000,
    });
    const error = (await generate({ prompt: "x" }).catch((e: unknown) => e)) as AppError;
    expect(error.type).toBe("config_missing");
    expect(error.recoverable).toBe(true);
  });

  it("reads array content parts and strips <think> blocks", async () => {
    const { generate } = nightshift([
      jsonResponse(
        chatReply([
          { type: "text", text: "<think>hmm</think>" },
          { type: "text", text: "answer" },
        ]),
      ),
    ]);
    expect((await generate({ prompt: "x" })).text).toBe("answer");
    expect(stripThinking("<think>a</think>\nresult")).toBe("result");
  });

  it("treats empty answers and non-JSON bodies as recoverable bad responses", async () => {
    const empty = nightshift([jsonResponse(chatReply(""))]);
    expect(((await empty.generate({ prompt: "x" }).catch((e: unknown) => e)) as AppError).type).toBe("bad_response");
    const html = nightshift([new Response("<html>oops</html>", { status: 200 })]);
    const error = (await html.generate({ prompt: "x" }).catch((e: unknown) => e)) as AppError;
    expect(error.type).toBe("bad_response");
    expect(error.recoverable).toBe(true);
  });

  it("classifies HTTP failures: server errors and auth are recoverable, bad requests are not", async () => {
    const statuses: Array<[number, boolean]> = [
      [500, true],
      [429, true],
      [401, true],
      [404, true],
      [400, false],
    ];
    for (const [status, recoverable] of statuses) {
      const { generate } = nightshift([jsonResponse({ error: "nope" }, status)]);
      const error = (await generate({ prompt: "x" }).catch((e: unknown) => e)) as AppError;
      expect(error.type).toBe("http_error");
      expect(error.recoverable).toBe(recoverable);
    }
  });
});

describe("Ollama generator", () => {
  it("calls the OpenAI-compatible endpoint without auth and reports a local route", async () => {
    const stub = stubFetch([jsonResponse(chatReply("ready", { model: "nemotron-3.5-lightning:30b" }))]);
    const generate = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "nemotron-3.5-lightning:30b",
      timeoutMs: 1000,
      fetchImpl: stub.fetchImpl,
    });
    const result = await generate({ prompt: "x" });
    expect(result).toMatchObject({ provider: "ollama", routeKind: "local", routedModel: "nemotron-3.5-lightning:30b" });
    const headers = stub.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("generator chain", () => {
  const ok = (provider: Provider) => async () => ({
    text: provider,
    provider,
    requestedModel: "r",
    routedModel: "r",
    routeKind: "local" as const,
    latencyMs: 1,
  });
  const failing = (recoverable: boolean) => async () => {
    throw new AppError("network", "down", { recoverable });
  };

  it("returns the first provider that answers, with no fallback record", async () => {
    const chain = createGeneratorChain([
      { provider: "nightshift", generate: ok("nightshift") },
      { provider: "ollama", generate: ok("ollama") },
    ]);
    const result = await chain({ prompt: "x" });
    expect(result.provider).toBe("nightshift");
    expect(result.fellBackFrom).toBeUndefined();
  });

  it("falls back on recoverable errors, records them and notifies the hook", async () => {
    const seen: Array<[Provider, StructuredError]> = [];
    const chain = createGeneratorChain(
      [
        { provider: "nightshift", generate: failing(true) },
        { provider: "ollama", generate: ok("ollama") },
      ],
      { onFallback: (p, e) => seen.push([p, e]) },
    );
    const result = await chain({ prompt: "x" });
    expect(result.provider).toBe("ollama");
    expect(result.fellBackFrom?.[0]?.provider).toBe("nightshift");
    expect(seen).toHaveLength(1);
  });

  it("stops at a non-recoverable error instead of hiding it", async () => {
    const chain = createGeneratorChain([
      { provider: "nightshift", generate: failing(false) },
      { provider: "ollama", generate: ok("ollama") },
    ]);
    await expect(chain({ prompt: "x" })).rejects.toMatchObject({ recoverable: false });
  });

  it("reports every attempt when all providers fail", async () => {
    const chain = createGeneratorChain([
      { provider: "nightshift", generate: failing(true) },
      { provider: "ollama", generate: failing(true) },
    ]);
    const error = (await chain({ prompt: "x" }).catch((e: unknown) => e)) as AppError;
    expect(error.message).toBe("all model providers failed");
    expect(error.details?.attempts).toHaveLength(2);
  });

  it("does not fall back once the caller has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const chain = createGeneratorChain([
      { provider: "nightshift", generate: failing(true) },
      { provider: "ollama", generate: ok("ollama") },
    ]);
    await expect(chain({ prompt: "x", signal: controller.signal })).rejects.toBeInstanceOf(AppError);
  });

  it("requires at least one provider", () => {
    expect(() => createGeneratorChain([])).toThrow();
  });
});

describe("buildGenerator", () => {
  it("uses Nightshift first, then Ollama, from configuration", async () => {
    const cfg = testConfig({ METERLESS_RUNTIME_TOKEN: TOKEN });
    const { fetchImpl, calls } = stubFetch([jsonResponse({}, 503), jsonResponse(chatReply("from ollama"))]);
    const generate = buildGenerator(cfg, { fetchImpl });
    const result = await generate({ prompt: "x", lane: "judge" });
    expect(result.provider).toBe("ollama");
    expect(calls[0]?.url).toBe(`${cfg.nightshift.baseUrl}/chat/completions`);
    expect(calls[1]?.url).toBe(`${cfg.ollama.baseUrl}/chat/completions`);
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe(cfg.nightshift.models.judge);
  });

  it("only adds the rules fallback in sample mode", async () => {
    const down = () => [new Error("down"), new Error("down")];
    const rules = () => "rules-answer";

    const live = buildGenerator(testConfig(), { fetchImpl: stubFetch(down()).fetchImpl, fallbackRules: rules });
    await expect(live({ prompt: "x" })).rejects.toBeInstanceOf(AppError);

    const sample = buildGenerator(testConfig({ SAMPLE_MODE: "true" }), {
      fetchImpl: stubFetch(down()).fetchImpl,
      fallbackRules: rules,
    });
    const result = await sample({ prompt: "x" });
    expect(result).toMatchObject({ provider: "fallback-rules", text: "rules-answer", routedModel: "fallback-rules" });
    expect(result.fellBackFrom?.map((f) => f.provider)).toEqual(["nightshift", "ollama"]);
  });

  it("labels the rules generator clearly", async () => {
    const result = await createFallbackRulesGenerator(() => "x")({ prompt: "p" });
    expect(result.provider).toBe("fallback-rules");
  });
});

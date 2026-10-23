import { describe, expect, it } from "vitest";
import {
  AppError,
  buildGenerator,
  createFallbackRulesGenerator,
  createGeneratorChain,
  createNightshiftGenerator,
  createOllamaGenerator,
  type GenerateResult,
  type ModelAttempt,
  modelTraceFields,
  type Provider,
  Secret,
  type StructuredError,
  stripThinking,
} from "../src/index.js";
import { chatReply, first, jsonResponse, nightshiftReply, signedReceipt, stubFetch, testConfig } from "./helpers.js";

const TOKEN = "rt-test-token-0123456789";
const modes = { fast: "meterless/fast", deep: "meterless/deep", judge: "meterless/judge" };

function nightshift(responses: Parameters<typeof stubFetch>[0], extra: { keys?: string[] } = {}) {
  const stub = stubFetch(responses);
  const attempts: ModelAttempt[] = [];
  const generate = createNightshiftGenerator({
    baseUrl: "http://nightshift.test/v1/",
    token: new Secret(TOKEN),
    appId: "test-app",
    scope: "user",
    models: modes,
    timeoutMs: 1000,
    receiptPublicKeys: extra.keys,
    onAttempt: (a) => attempts.push(a),
    fetchImpl: stub.fetchImpl,
  });
  const sentModels = () => stub.calls.map((c) => JSON.parse(String(c.init.body)).model as string);
  return { generate, calls: stub.calls, attempts, sentModels };
}

const refuse = async (p: Promise<unknown>): Promise<AppError> => (await p.catch((e: unknown) => e)) as AppError;

describe("Nightshift generator", () => {
  it("sends auth and app headers, uses the fast lane by default and reports the route", async () => {
    const { generate, calls, sentModels } = nightshift([jsonResponse(nightshiftReply("ready"))]);
    const result = await generate({ prompt: "hi", system: "be brief", temperature: 0, maxTokens: 20 });

    expect(result).toMatchObject({
      text: "ready",
      provider: "nightshift",
      requestedModel: "meterless/fast",
      routedModel: "local-runtime/nemotron",
      routeKind: "local",
      servedMode: "meterless/fast",
      modeMismatch: false,
      fromCache: false,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    expect(sentModels()).toEqual(["meterless/fast"]);
    const call = first(calls);
    expect(call.url).toBe("http://nightshift.test/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["meterless-app"]).toBe("test-app");
    expect(headers["meterless-scope"]).toBe("user");
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({ stream: false, temperature: 0, max_tokens: 20 });
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("maps each lane to its pinned mode and lets an explicit pinned mode override the lane", async () => {
    const { generate, sentModels } = nightshift([
      jsonResponse(nightshiftReply("a")),
      jsonResponse(nightshiftReply("b")),
      jsonResponse(nightshiftReply("c")),
    ]);
    await generate({ prompt: "x", lane: "deep" });
    await generate({ prompt: "x", lane: "judge" });
    await generate({ prompt: "x", lane: "deep", model: "meterless/text.deep" });
    expect(sentModels()).toEqual(["meterless/deep", "meterless/judge", "meterless/text.deep"]);
  });

  it("never sends meterless/auto or any non-pinned id, and makes no request for them", async () => {
    for (const bad of ["meterless/auto", "nvidia/nemotron-3-super-120b-a12b", "fast"]) {
      const { generate, calls } = nightshift([jsonResponse(nightshiftReply("x"))]);
      const error = await refuse(generate({ prompt: "x", model: bad }));
      expect(error.type, bad).toBe("validation");
      expect(error.recoverable).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("fails with a recoverable config error when no token is set", async () => {
    const generate = createNightshiftGenerator({
      baseUrl: "http://nightshift.test/v1",
      appId: "a",
      scope: "user",
      models: modes,
      timeoutMs: 1000,
    });
    const error = await refuse(generate({ prompt: "x" }));
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
    expect((await refuse(empty.generate({ prompt: "x" }))).type).toBe("bad_response");
    const html = nightshift([new Response("<html>oops</html>", { status: 200 })]);
    const error = await refuse(html.generate({ prompt: "x" }));
    expect(error.type).toBe("bad_response");
    expect(error.recoverable).toBe(true);
  });

  it("classifies HTTP failures: server errors and auth are recoverable, other bad requests are not", async () => {
    const statuses: Array<[number, boolean]> = [
      [500, true],
      [429, true],
      [401, true],
      [404, true],
      [400, false],
    ];
    for (const [status, recoverable] of statuses) {
      const { generate } = nightshift([jsonResponse({ error: "nope" }, status)]);
      const error = await refuse(generate({ prompt: "x" }));
      expect(error.type).toBe("http_error");
      expect(error.recoverable).toBe(recoverable);
    }
  });
});

describe("dead routes", () => {
  it("retries once on the next configured mode after HTTP 410 and reports both attempts", async () => {
    const { generate, sentModels, attempts } = nightshift([
      jsonResponse({ error: { code: "model_retired" } }, 410),
      jsonResponse(nightshiftReply("ok", { meterless: { provider_model: "meterless/deep" } })),
    ]);
    const result = await generate({ prompt: "x", lane: "fast" });

    expect(sentModels()).toEqual(["meterless/fast", "meterless/deep"]);
    expect(result.requestedModel).toBe("meterless/deep");
    expect(result.deadRoutes).toEqual([{ model: "meterless/fast", status: 410 }]);
    expect(attempts.map((a) => [a.requestedModel, a.outcome, a.status])).toEqual([
      ["meterless/fast", "dead_route", 410],
      ["meterless/deep", "ok", 200],
    ]);
    expect(attempts[1]).toMatchObject({ routedModel: "local-runtime/nemotron", servedMode: "meterless/deep" });
  });

  it("treats HTTP 400 class_no_route as dead, but not other 400s", async () => {
    const dead = nightshift([
      jsonResponse({ error: { code: "class_no_route", message: "no route" } }, 400),
      jsonResponse(nightshiftReply("ok")),
    ]);
    const result = await dead.generate({ prompt: "x", lane: "judge" });
    expect(result.deadRoutes).toEqual([{ model: "meterless/judge", status: 400, code: "class_no_route" }]);
    expect(dead.sentModels()).toEqual(["meterless/judge", "meterless/fast"]);

    const other = nightshift([
      jsonResponse({ error: { code: "bad_param" } }, 400),
      jsonResponse(nightshiftReply("ok")),
    ]);
    const error = await refuse(other.generate({ prompt: "x" }));
    expect(error.type).toBe("http_error");
    expect(other.sentModels()).toEqual(["meterless/fast"]);
  });

  it("treats a cloud 'Function not found' as dead, whether it arrives as 502 or 404", async () => {
    const body = {
      error: {
        message: `404: {"status":404,"title":"Not Found","detail":"Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not Found for account 'x'"}`,
      },
    };
    for (const status of [502, 404]) {
      const { generate, sentModels } = nightshift([jsonResponse(body, status), jsonResponse(nightshiftReply("ok"))]);
      const result = await generate({ prompt: "x", lane: "deep" });
      expect(result.deadRoutes).toEqual([{ model: "meterless/deep", status, code: "function_not_found" }]);
      expect(sentModels()).toEqual(["meterless/deep", "meterless/judge"]);
    }
  });

  it("does not treat an unrelated 404 or 502 as a dead route", async () => {
    for (const status of [404, 502]) {
      const { generate, sentModels } = nightshift([jsonResponse({ error: { message: "upstream timeout" } }, status)]);
      const error = await refuse(generate({ prompt: "x" }));
      expect(error.type).toBe("http_error");
      expect(error.recoverable).toBe(true);
      expect(sentModels()).toEqual(["meterless/fast"]);
    }
  });

  it("picks the next mode in lane order, wrapping around, and starts from fast for an unlisted mode", async () => {
    const order = async (req: { lane?: "fast" | "deep" | "judge"; model?: string }) => {
      const { generate, sentModels } = nightshift([jsonResponse({}, 410), jsonResponse(nightshiftReply("ok"))]);
      await generate({ prompt: "x", ...req });
      return sentModels();
    };
    expect(await order({ lane: "fast" })).toEqual(["meterless/fast", "meterless/deep"]);
    expect(await order({ lane: "deep" })).toEqual(["meterless/deep", "meterless/judge"]);
    expect(await order({ lane: "judge" })).toEqual(["meterless/judge", "meterless/fast"]);
    expect(await order({ model: "meterless/text.deep" })).toEqual(["meterless/text.deep", "meterless/fast"]);
  });

  it("gives up after the one retry with a recoverable route_dead error", async () => {
    const { generate, sentModels, attempts } = nightshift([jsonResponse({}, 410), jsonResponse({}, 410)]);
    const error = await refuse(generate({ prompt: "x" }));
    expect(error.type).toBe("route_dead");
    expect(error.recoverable).toBe(true);
    expect(sentModels()).toHaveLength(2);
    expect(attempts.every((a) => a.outcome === "dead_route")).toBe(true);
    expect(JSON.stringify(error.details)).toContain("meterless/deep");
  });

  it("falls back to Ollama after two dead routes and records why", async () => {
    const cfg = testConfig({ METERLESS_RUNTIME_TOKEN: TOKEN });
    const { fetchImpl, calls } = stubFetch([
      jsonResponse({}, 410),
      jsonResponse({}, 410),
      jsonResponse(chatReply("from ollama", { model: "nemotron-3.5-lightning:30b" })),
    ]);
    const attempts: ModelAttempt[] = [];
    const generate = buildGenerator(cfg, { fetchImpl, onAttempt: (a) => attempts.push(a) });
    const result = await generate({ prompt: "x", lane: "fast" });

    expect(result.provider).toBe("ollama");
    expect(result.fellBackFrom?.[0]).toMatchObject({ provider: "nightshift", error: { type: "route_dead" } });
    expect(calls).toHaveLength(3);
    expect(attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
      "nightshift:dead_route",
      "nightshift:dead_route",
      "ollama:ok",
    ]);
    expect(attempts[2]).toMatchObject({ requestedModel: cfg.ollama.model, routedModel: "nemotron-3.5-lightning:30b" });
  });
});

describe("what the runtime reports", () => {
  it("flags when the runtime served a different mode than the one pinned, and a cache hit", async () => {
    const { generate, attempts } = nightshift([
      jsonResponse(nightshiftReply("ok", { meterless: { provider_model: "meterless/auto", from_cache: true } })),
    ]);
    const result = await generate({ prompt: "x", lane: "fast" });
    expect(result).toMatchObject({ servedMode: "meterless/auto", modeMismatch: true, fromCache: true });
    expect(attempts[0]).toMatchObject({ servedMode: "meterless/auto", outcome: "ok" });
    expect(modelTraceFields(result).detail).toMatchObject({
      served_mode: "meterless/auto",
      mode_mismatch: true,
      from_cache: true,
    });
  });

  it("captures and verifies the signed receipt, and keeps the full envelope", async () => {
    const signed = signedReceipt();
    const { generate } = nightshift([jsonResponse(nightshiftReply("ok", { signed }))]);
    const result = await generate({ prompt: "x" });
    expect(result.receipt).toMatchObject({
      receipt_id: "rcpt_test_1",
      decision_id: "req_test_1",
      signer: "meterlessd",
      pubkey_b64: signed.publicKeyB64,
      verification: "valid_unpinned",
      from_cache: false,
    });
    expect(result.receipt?.body_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receiptEnvelope).toEqual(signed.envelope);
  });

  it("marks the receipt pinned when the runtime key is trusted, and invalid when the body was altered", async () => {
    const signed = signedReceipt();
    const pinned = nightshift([jsonResponse(nightshiftReply("ok", { signed }))], { keys: [signed.publicKeyB64] });
    expect((await pinned.generate({ prompt: "x" })).receipt?.verification).toBe("valid_pinned");

    const tampered = { ...signed, envelope: { ...signed.envelope, body: { ...signed.envelope.body, signer: "evil" } } };
    const altered = nightshift([jsonResponse(nightshiftReply("ok", { signed: tampered }))], {
      keys: [signed.publicKeyB64],
    });
    expect((await altered.generate({ prompt: "x" })).receipt?.verification).toBe("invalid");
  });

  it("works without a receipt when the response has none", async () => {
    const { generate } = nightshift([jsonResponse(chatReply("ok"))]);
    const result = await generate({ prompt: "x" });
    expect(result.receipt).toBeUndefined();
    expect(result.receiptEnvelope).toBeUndefined();
    expect(result.modeMismatch).toBe(false);
  });

  it("turns a result into trace fields: requested and routed model, route, tokens and receipt", async () => {
    const { generate } = nightshift([jsonResponse(nightshiftReply("ok"))]);
    const fields = modelTraceFields(await generate({ prompt: "x", lane: "judge" }));
    expect(fields).toMatchObject({
      provider: "nightshift",
      model_requested: "meterless/judge",
      model_used: "local-runtime/nemotron",
      route_kind: "local",
      tokens_in: 5,
      tokens_out: 2,
    });
    expect(fields.receipt?.receipt_id).toBe("rcpt_test_1");
  });
});

describe("Ollama generator", () => {
  it("calls the OpenAI-compatible endpoint without auth, ignoring Nightshift mode names", async () => {
    const stub = stubFetch([jsonResponse(chatReply("ready", { model: "nemotron-3.5-lightning:30b" }))]);
    const attempts: ModelAttempt[] = [];
    const generate = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "nemotron-3.5-lightning:30b",
      timeoutMs: 1000,
      onAttempt: (a) => attempts.push(a),
      fetchImpl: stub.fetchImpl,
    });
    const result = await generate({ prompt: "x", model: "meterless/text.deep" });
    expect(result).toMatchObject({ provider: "ollama", routeKind: "local", routedModel: "nemotron-3.5-lightning:30b" });
    expect(JSON.parse(String(first(stub.calls).init.body)).model).toBe("nemotron-3.5-lightning:30b");
    expect((first(stub.calls).init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(attempts[0]).toMatchObject({ provider: "ollama", outcome: "ok" });
  });

  it("reports why the model stopped, and asks Ollama for a JSON-only answer when told to", async () => {
    const stub = stubFetch([
      jsonResponse(chatReply("{}", { choices: [{ message: { content: "{}" }, finish_reason: "length" }] })),
    ]);
    const generate = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "m",
      timeoutMs: 1000,
      fetchImpl: stub.fetchImpl,
    });
    const result = await generate({ prompt: "x", jsonMode: true });
    expect(result.finishReason).toBe("length");
    expect(JSON.parse(String(first(stub.calls).init.body)).response_format).toEqual({ type: "json_object" });
  });

  it("sends a strict JSON Schema as the response format when given one", async () => {
    const stub = stubFetch([jsonResponse(chatReply("{}"))]);
    const generate = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "m",
      timeoutMs: 1000,
      fetchImpl: stub.fetchImpl,
    });
    const schema = { type: "object", properties: { a: { type: "string" } } };
    await generate({ prompt: "x", jsonSchema: { name: "answer", schema } });
    expect(JSON.parse(String(first(stub.calls).init.body)).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", strict: true, schema },
    });
  });

  it("does not ask for JSON mode unless told to", async () => {
    const stub = stubFetch([jsonResponse(chatReply("ok"))]);
    const generate = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "m",
      timeoutMs: 1000,
      fetchImpl: stub.fetchImpl,
    });
    await generate({ prompt: "x" });
    expect(JSON.parse(String(first(stub.calls).init.body)).response_format).toBeUndefined();
  });

  it("reports failed attempts with their error type", async () => {
    const attempts: ModelAttempt[] = [];
    const down = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "m",
      timeoutMs: 1000,
      onAttempt: (a) => attempts.push(a),
      fetchImpl: stubFetch([new Error("refused")]).fetchImpl,
    });
    await refuse(down({ prompt: "x" }));
    const empty = createOllamaGenerator({
      baseUrl: "http://ollama.test/v1",
      model: "m",
      timeoutMs: 1000,
      onAttempt: (a) => attempts.push(a),
      fetchImpl: stubFetch([jsonResponse(chatReply(""))]).fetchImpl,
    });
    await refuse(empty({ prompt: "x" }));
    expect(attempts.map((a) => [a.outcome, a.errorType])).toEqual([
      ["error", "network"],
      ["error", "bad_response"],
    ]);
  });
});

describe("generator chain", () => {
  const ok = (provider: Provider) => async (): Promise<GenerateResult> => ({
    text: provider,
    provider,
    requestedModel: "r",
    routedModel: "r",
    routeKind: "local",
    latencyMs: 1,
    modeMismatch: false,
  });
  const failing = (recoverable: boolean) => async (): Promise<GenerateResult> => {
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

  it("asks only the named provider when it is in the chain, and the whole chain when it is not", async () => {
    const chain = createGeneratorChain([
      { provider: "nightshift", generate: ok("nightshift") },
      { provider: "ollama", generate: ok("ollama") },
    ]);
    expect((await chain({ prompt: "x", provider: "ollama" })).provider).toBe("ollama");
    const rulesOnly = createGeneratorChain([{ provider: "fallback-rules", generate: ok("fallback-rules") }]);
    expect((await rulesOnly({ prompt: "x", provider: "ollama" })).provider).toBe("fallback-rules");
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
    const error = await refuse(chain({ prompt: "x" }));
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
  it("uses Nightshift first, then Ollama, with pinned modes from configuration", async () => {
    const cfg = testConfig({ METERLESS_RUNTIME_TOKEN: TOKEN });
    const { fetchImpl, calls } = stubFetch([jsonResponse({}, 503), jsonResponse(chatReply("from ollama"))]);
    const generate = buildGenerator(cfg, { fetchImpl });
    const result = await generate({ prompt: "x", lane: "judge" });
    expect(result.provider).toBe("ollama");
    expect(first(calls).url).toBe(`${cfg.nightshift.baseUrl}/chat/completions`);
    expect(calls[1]?.url).toBe(`${cfg.ollama.baseUrl}/chat/completions`);
    expect(JSON.parse(String(first(calls).init.body)).model).toBe(cfg.nightshift.models.judge);
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
    expect(result.modeMismatch).toBe(false);
  });
});

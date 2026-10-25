import type { GenerateResult, Generator, ReceiptVerification } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askJson, receiptProblem, runReview } from "../src/index.js";
import { caseFacts, sampleDeps, scriptedGenerator } from "./helpers.js";

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
const ask = (generator: Generator) =>
  askJson(sampleDeps({ generator }), {
    agent: "decision",
    system: "s",
    prompt: "p",
    schema: z.object({ value: z.number() }),
  });

describe("the receipt gate", () => {
  it("names the problem for every receipt that is not signed by the pinned key", () => {
    expect(receiptProblem(answer(OK, { receipt: receipt("valid_pinned") }))).toBeUndefined();
    expect(receiptProblem(answer(OK))).toBe("receipt missing");
    expect(receiptProblem(answer(OK, { receipt: receipt("valid_unpinned") }))).toBe(
      "receipt not signed by the pinned key",
    );
    expect(receiptProblem(answer(OK, { receipt: receipt("invalid") }))).toBe("receipt invalid");
    expect(receiptProblem(answer(OK, { receipt: receipt("malformed") }))).toBe("receipt malformed");
  });

  it("leaves the Ollama backup and the sample stand-in alone: they have no receipt by design", () => {
    expect(receiptProblem(answer(OK, { provider: "ollama" }))).toBeUndefined();
    expect(receiptProblem(answer(OK, { provider: "fallback-rules" }))).toBeUndefined();
  });

  it("does not use an answer with a bad receipt, retries, and uses the next answer that is signed by the pinned key", async () => {
    const replies = [answer(OK, { receipt: receipt("invalid") }), answer(OK, { receipt: receipt("valid_pinned") })];
    const r = await ask(async () => replies.shift() as GenerateResult);
    expect(r.value).toEqual({ value: 1 });
    expect(r.calls[0]?.receipt_rejected).toBe("receipt invalid");
    expect(r.calls[1]?.receipt_rejected).toBeUndefined();
  });

  it("uses an Ollama backup answer, which has no receipt", async () => {
    const r = await ask(async () => answer(OK, { provider: "ollama", routeKind: "local" }));
    expect(r.value).toEqual({ value: 1 });
  });

  it("holds the case when no answer has a receipt signed by the pinned key", async () => {
    const fp = caseFacts("fp_dob_exact_name_0");
    const { generator: scripted } = scriptedGenerator([
      JSON.stringify({ violation: false, category: "none", reasons: [] }),
    ]);
    // Every answer comes back as if from Nightshift, with a receipt that does not verify.
    const generator: Generator = async (req) => ({
      ...(await scripted(req)),
      provider: "nightshift",
      receipt: receipt("invalid"),
    });
    const deps = sampleDeps({ generator });
    const res = await runReview(deps, { runId: "receipt-gate", alertId: fp.alertId, sampleMode: true });
    expect(res.decision).not.toBe("CLOSE_FALSE_POSITIVE");
    expect(res.rationale).toContain("model decision unavailable");
  });
});

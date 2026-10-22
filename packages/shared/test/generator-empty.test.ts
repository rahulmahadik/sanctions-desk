import { describe, expect, it } from "vitest";
import { type AppError, createOllamaGenerator } from "../src/index.js";
import { jsonResponse, stubFetch } from "./helpers.js";

function ollama(body: unknown) {
  return createOllamaGenerator({
    baseUrl: "http://ollama.test/v1",
    model: "m",
    timeoutMs: 1000,
    fetchImpl: stubFetch([jsonResponse(body)]).fetchImpl,
  });
}

describe("empty answers", () => {
  it("explains when a reasoning model used its whole token budget", async () => {
    const generate = ollama({ choices: [{ finish_reason: "length", message: { content: "" } }] });
    const error = (await generate({ prompt: "x", maxTokens: 8 }).catch((e: unknown) => e)) as AppError;
    expect(error.type).toBe("bad_response");
    expect(error.recoverable).toBe(true);
    expect(error.message).toContain("raise maxTokens");
    expect(error.details).toMatchObject({ finish_reason: "length" });
  });

  it("reports a plain empty answer without the token hint", async () => {
    const generate = ollama({ choices: [{ finish_reason: "stop", message: { content: "" } }] });
    const error = (await generate({ prompt: "x" }).catch((e: unknown) => e)) as AppError;
    expect(error.message).toBe("ollama returned an empty answer");
  });
});

import { describe, expect, it } from "vitest";
import { AppError, makeRedactor, Secret, toStructuredError, withholdQuoted } from "../src/index.js";

describe("makeRedactor", () => {
  it("masks exact secret values anywhere in a string", () => {
    const redact = makeRedactor(["abc123secretvalue"]);
    expect(redact("token=abc123secretvalue end")).toBe("token=[REDACTED] end");
  });

  it("masks bearer tokens and well-known key shapes", () => {
    const redact = makeRedactor();
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: [REDACTED]");
    expect(redact("key nvapi-AbCdEf123456_x ok")).toBe("key [REDACTED] ok");
    expect(redact("sk-ABCDEFGHIJKLMNOPQRSTUV")).toBe("[REDACTED]");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]");
  });

  it("does not touch ordinary words that merely contain 'sk-'", () => {
    expect(makeRedactor()("risk-based approach and task-queue")).toBe("risk-based approach and task-queue");
  });

  it("masks values under secret-looking keys, recursively", () => {
    const redact = makeRedactor();
    const out = redact({ a: { api_key: "plain", note: "fine" }, list: [{ Authorization: "x" }], n: 3 });
    expect(out).toEqual({ a: { api_key: "[REDACTED]", note: "fine" }, list: [{ Authorization: "[REDACTED]" }], n: 3 });
  });

  it("ignores very short or missing secrets", () => {
    expect(makeRedactor(["abc", undefined])("abc stays")).toBe("abc stays");
  });
});

describe("Secret", () => {
  it("only reveals its value through reveal()", () => {
    const s = new Secret("hunter2-value");
    expect(s.reveal()).toBe("hunter2-value");
    expect(String(s)).toBe("[REDACTED]");
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
  });
});

describe("AppError", () => {
  it("serialises to a structured error", () => {
    const err = new AppError("timeout", "too slow", { recoverable: true, details: { ms: 5 } });
    expect(err.toJSON()).toEqual({ type: "timeout", message: "too slow", recoverable: true, details: { ms: 5 } });
  });

  it("turns unknown errors into non-recoverable internal errors", () => {
    expect(toStructuredError(new Error("boom"))).toEqual({ type: "internal", message: "boom", recoverable: false });
    expect(toStructuredError("text").message).toBe("text");
  });
});

describe("withholdQuoted and token_source", () => {
  it("withholds quoted values and keeps the meaning", () => {
    expect(withholdQuoted('customer.date_of_birth is "1978-01-15", not "1967-01-17"')).toBe(
      "customer.date_of_birth is [value withheld], not [value withheld]",
    );
  });
  it("does not hide which kind of credential a query used", () => {
    const redact = makeRedactor();
    expect(redact({ token_source: "role", api_key: "abcdefgh" })).toEqual({
      token_source: "role",
      api_key: "[REDACTED]",
    });
  });
});

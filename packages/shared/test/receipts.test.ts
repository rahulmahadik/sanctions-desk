import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractReceipt,
  ReceiptSummarySchema,
  TraceEventSchema,
  verifyReceipt,
  writeReceiptFile,
} from "../src/index.js";
import { signedReceipt, tempDir } from "./helpers.js";

describe("verifyReceipt", () => {
  it("accepts a correctly signed receipt, pinned only when the key is trusted", () => {
    const { envelope, publicKeyB64 } = signedReceipt();
    expect(verifyReceipt(envelope).status).toBe("valid_unpinned");
    expect(verifyReceipt(envelope, [publicKeyB64]).status).toBe("valid_pinned");
    expect(verifyReceipt(envelope, ["AAAA"]).status).toBe("valid_unpinned");
    expect(verifyReceipt(envelope).bodyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not depend on key order inside the body", () => {
    const { envelope } = signedReceipt({ zeta: 1, alpha: { b: 2, a: 1 } });
    const reordered = { ...envelope, body: Object.fromEntries(Object.entries(envelope.body).reverse()) };
    expect(verifyReceipt(reordered).status).toBe("valid_unpinned");
  });

  it("rejects any change to the body or the signature", () => {
    const { envelope } = signedReceipt();
    expect(verifyReceipt({ ...envelope, body: { ...envelope.body, signer: "other" } }).status).toBe("invalid");
    expect(verifyReceipt({ ...envelope, body: { ...envelope.body, extra: true } }).status).toBe("invalid");
    const flipped = Buffer.from(envelope.sig_b64, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(verifyReceipt({ ...envelope, sig_b64: flipped.toString("base64") }).status).toBe("invalid");
  });

  it("rejects a receipt signed by a different key", () => {
    const a = signedReceipt();
    const b = signedReceipt();
    expect(verifyReceipt({ ...a.envelope, pubkey_b64: b.publicKeyB64 }).status).toBe("invalid");
  });

  it("reports malformed input without throwing", () => {
    const { envelope } = signedReceipt();
    expect(verifyReceipt(null).status).toBe("malformed");
    expect(verifyReceipt({ body: {}, pubkey_b64: "x", sig_b64: "y" }).status).toBe("malformed");
    expect(verifyReceipt({ ...envelope, pubkey_b64: Buffer.alloc(31).toString("base64") }).reason).toContain(
      "32 bytes",
    );
    expect(verifyReceipt({ ...envelope, sig_b64: Buffer.alloc(10).toString("base64") }).reason).toContain("64 bytes");
    expect(verifyReceipt({ ...envelope, body: { n: Number.NaN } }).status).toBe("malformed");
    expect(verifyReceipt({ ...envelope, pubkey_b64: Buffer.alloc(32).toString("base64") }).status).not.toBe(
      "valid_unpinned",
    );
  });
});

describe("extractReceipt", () => {
  it("builds a compact summary that fits the trace schema", () => {
    const { envelope } = signedReceipt();
    const extracted = extractReceipt({
      receipt_id: "rcpt_1",
      decision_id: "req_1",
      from_cache: true,
      receipt_envelope: envelope,
    });
    expect(extracted?.summary).toMatchObject({
      receipt_id: "rcpt_1",
      decision_id: "req_1",
      signer: "meterlessd",
      ts_ms: 1792682433801,
      verification: "valid_unpinned",
      from_cache: true,
    });
    expect(ReceiptSummarySchema.safeParse(extracted?.summary).success).toBe(true);
    const event = TraceEventSchema.safeParse({
      ts: "2026-10-23T00:00:00.000Z",
      run_id: "r",
      seq: 0,
      agent: "decision",
      action: "generate",
      status: "ok",
      receipt: extracted?.summary,
    });
    expect(event.success).toBe(true);
  });

  it("returns nothing when there is no usable receipt", () => {
    expect(extractReceipt(undefined)).toBeUndefined();
    expect(extractReceipt({})).toBeUndefined();
    expect(extractReceipt({ receipt_id: "r" })).toBeUndefined();
    expect(extractReceipt({ receipt_id: "r", receipt_envelope: { nope: true } })).toBeUndefined();
  });

  it("still returns a summary, marked invalid, when the signature is wrong", () => {
    const { envelope } = signedReceipt();
    const extracted = extractReceipt({
      receipt_id: "r",
      receipt_envelope: { ...envelope, body: { ...envelope.body, x: 1 } },
    });
    expect(extracted?.summary.verification).toBe("invalid");
  });
});

describe("writeReceiptFile", () => {
  it("stores the full envelope under receipts/<id>.json", () => {
    const dir = tempDir();
    const { envelope } = signedReceipt();
    const file = writeReceiptFile(dir, "rcpt_req_abc123", envelope);
    expect(file).toBe(join(dir, "receipts", "rcpt_req_abc123.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(envelope);
  });

  it("refuses ids that could escape the folder", () => {
    const dir = tempDir();
    const { envelope } = signedReceipt();
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(101)]) {
      expect(() => writeReceiptFile(dir, bad, envelope), bad).toThrow(/not safe/);
    }
    expect(existsSync(join(dir, "x"))).toBe(false);
  });
});

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { tamperOneByte } from "../../../tools/lib/receipt-tamper.js";

/** A receipt signed the way Nightshift signs one: Ed25519 over the canonical JSON of its body. */
function signedReceipt(): { line: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const key = der.subarray(der.length - 32).toString("base64");
  const body = { signer: "test", ts_ms: 1792900000000, receipt: { receipt_id: "r-1" } };
  const sig = sign(
    null,
    Buffer.from(canonicalJson(body)),
    createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
  return { line: JSON.stringify({ body, pubkey_b64: key, sig_b64: sig.toString("base64") }), key };
}

describe("the one-byte tamper test", () => {
  it("passes the original and fails the copy with one byte changed", () => {
    const { line, key } = signedReceipt();
    const r = tamperOneByte(line, [key]);
    expect(r.before).toBe("valid_pinned");
    expect(r.after).toBe("invalid");
  });

  it("leaves the receipt it was given as it was", () => {
    const { line, key } = signedReceipt();
    const copy = line.slice();
    tamperOneByte(line, [key]);
    expect(line).toBe(copy);
  });

  it("fails a receipt signed by a key that is not the pinned one", () => {
    const { line } = signedReceipt();
    expect(tamperOneByte(line, [signedReceipt().key]).before).toBe("invalid");
  });
});

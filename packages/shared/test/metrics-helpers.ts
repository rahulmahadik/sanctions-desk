import type { ReceiptSummary, ReceiptVerification } from "../src/index.js";

export * from "../src/index.js";

export function signedReceiptSummaryForTests(verification: ReceiptVerification): ReceiptSummary {
  return {
    receipt_id: "rcpt_x",
    pubkey_b64: "00OsSOXGbDitkESZueIJqDPdf9bXAvyrL+8cYDbY6II=",
    sig_b64: "A".repeat(86) + "==",
    body_hash: "a".repeat(64),
    verification,
  };
}

import { type ReceiptVerification, verifyReceipt } from "@sanctions-desk/shared";

export interface TamperCheck {
  before: ReceiptVerification;
  after: ReceiptVerification;
  /** Where in the receipt's JSON text the one byte was changed. */
  changedAt: number;
}

/**
 * Change one byte of a receipt's signed body (a digit of its timestamp, so the JSON stays valid) and verify it again.
 * The receipt passed in is not modified: the change is made to a copy of its text.
 */
export function tamperOneByte(line: string, trusted: readonly string[]): TamperCheck {
  const before = verifyReceipt(JSON.parse(line), trusted).status;
  const m = /"ts_ms":\s*\d/.exec(line);
  if (!m) throw new Error("the receipt has no signed timestamp to change");
  const digit = m.index + m[0].length - 1;
  const changed = `${line.slice(0, digit)}${line[digit] === "9" ? "8" : String(Number(line[digit]) + 1)}${line.slice(digit + 1)}`;
  return { before, after: verifyReceipt(JSON.parse(changed), trusted).status, changedAt: digit };
}

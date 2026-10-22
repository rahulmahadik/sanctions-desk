import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, no whitespace, so the same data always hashes the same.
 * Undefined properties are omitted (as JSON.stringify would); non-finite numbers are rejected
 * because they have no JSON form and would make two different values hash alike.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot hash a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  throw new TypeError(`cannot hash a value of type ${typeof value}`);
}

export const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of any JSON-compatible value, independent of key order. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Hash of one source row as Zetaris returns it (every value a string). Used for memory pointers and
 * decision records: it proves what a row contained without keeping a copy of the row.
 */
export function hashRow(row: Readonly<Record<string, string>>): string {
  return hashValue(row);
}

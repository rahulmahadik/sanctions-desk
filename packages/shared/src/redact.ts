/** Secret redaction. Applied to every trace line and every error detail before it is written anywhere. */

const PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /nvapi-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_KEY_NAMES = /(authorization|api[_-]?key|token|secret|password|passwd)/i;
/** Keys that look like secret names but hold no secret: which kind of credential a query used ("role" or "fallback"). */
const NOT_SECRET_KEYS = new Set(["token_source"]);

export type Redactor = <T>(value: T) => T;

/** Build a redactor that also masks the exact secret values it is given (e.g. from config). */
export function makeRedactor(secrets: Array<string | undefined> = []): Redactor {
  const exact = secrets.filter((s): s is string => typeof s === "string" && s.length >= 6);

  const scrubString = (s: string): string => {
    let out = s;
    for (const secret of exact) out = out.split(secret).join("[REDACTED]");
    for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
    return out;
  };

  const walk = (v: unknown, keyHint?: string): unknown => {
    if (typeof v === "string") {
      if (keyHint && SECRET_KEY_NAMES.test(keyHint) && !NOT_SECRET_KEYS.has(keyHint) && v.length > 0)
        return "[REDACTED]";
      return scrubString(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };

  return ((value: unknown) => walk(value)) as Redactor;
}

/**
 * For trace lines: every quoted value ("…") is replaced by [value withheld], so a reason such as
 * `customer.date_of_birth is "1978-01-15", not "1967-01-17"` keeps its meaning without the customer's values. The
 * sealed record keeps the full reason for the auditor.
 */
export const withholdQuoted = (text: string): string => text.replace(/["“][^"”]*["”]|'[^']{2,}'/g, "[value withheld]");

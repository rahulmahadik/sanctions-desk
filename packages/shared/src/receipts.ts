import { createPublicKey, verify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "./errors.js";
import { canonicalJson, SHA256_HEX, sha256Hex } from "./hashing.js";

/**
 * Nightshift signs a receipt for every answer. The envelope is
 *   { body: { signer, ts_ms, manifest_hash, receipt, ... }, pubkey_b64, sig_b64 }
 * and the signature is Ed25519 over the sorted-key, whitespace-free JSON of `body`.
 *
 * The public key travels inside the same response, so a valid signature proves the receipt was not
 * changed after it was signed, not who signed it. Pin the runtime's key (config
 * `nightshift.receiptPublicKeys`) to turn "valid" into "valid and from our runtime".
 */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64");

export const ReceiptEnvelopeSchema = z.object({
  body: z.record(z.string(), z.unknown()),
  pubkey_b64: base64,
  sig_b64: base64,
});
export type ReceiptEnvelope = z.infer<typeof ReceiptEnvelopeSchema>;

export const RECEIPT_VERIFICATION = ["valid_pinned", "valid_unpinned", "invalid", "malformed"] as const;
export type ReceiptVerification = (typeof RECEIPT_VERIFICATION)[number];

/** The compact form kept in trace lines and decision records. The full envelope is stored separately. */
export const ReceiptSummarySchema = z.strictObject({
  receipt_id: z.string().min(1),
  decision_id: z.string().min(1).optional(),
  signer: z.string().min(1).optional(),
  ts_ms: z.number().int().nonnegative().optional(),
  pubkey_b64: base64,
  sig_b64: base64,
  /** SHA-256 of the signed bytes, so the stored envelope can be matched to this summary. */
  body_hash: z.string().regex(SHA256_HEX),
  verification: z.enum(RECEIPT_VERIFICATION),
  /** Nightshift's own manifest hash for the model set that produced the answer. */
  manifest_hash: z.string().min(1).optional(),
  from_cache: z.boolean().optional(),
});
export type ReceiptSummary = z.infer<typeof ReceiptSummarySchema>;

export interface VerifyResult {
  status: ReceiptVerification;
  reason?: string;
  bodyHash?: string;
}

export function verifyReceipt(input: unknown, trustedKeys: readonly string[] = []): VerifyResult {
  const parsed = ReceiptEnvelopeSchema.safeParse(input);
  if (!parsed.success) return { status: "malformed", reason: "not a receipt envelope" };
  const { body, pubkey_b64, sig_b64 } = parsed.data;

  const publicKey = Buffer.from(pubkey_b64, "base64");
  const signature = Buffer.from(sig_b64, "base64");
  if (publicKey.length !== PUBLIC_KEY_BYTES) return { status: "malformed", reason: "public key is not 32 bytes" };
  if (signature.length !== SIGNATURE_BYTES) return { status: "malformed", reason: "signature is not 64 bytes" };

  let signed: string;
  try {
    signed = canonicalJson(body);
  } catch {
    return { status: "malformed", reason: "body cannot be canonicalised" };
  }
  const bodyHash = sha256Hex(signed);

  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    ok = verify(null, Buffer.from(signed, "utf8"), key, signature);
  } catch {
    return { status: "malformed", reason: "public key is not a valid Ed25519 key", bodyHash };
  }
  if (!ok) return { status: "invalid", reason: "signature does not match the body", bodyHash };
  if (trustedKeys.includes(pubkey_b64)) return { status: "valid_pinned", bodyHash };
  // With a key pinned, a receipt signed by any other key is not accepted, however valid its own signature.
  if (trustedKeys.length > 0)
    return { status: "invalid", reason: "signed by a key that is not the pinned one", bodyHash };
  return { status: "valid_unpinned", bodyHash };
}

export interface ExtractedReceipt {
  summary: ReceiptSummary;
  envelope: ReceiptEnvelope;
}

/**
 * Pull the receipt out of a Nightshift response's `meterless` block and verify it.
 * Returns undefined when the response carries no receipt (for example another provider).
 */
export function extractReceipt(
  meterless: Record<string, unknown> | undefined,
  trustedKeys: readonly string[] = [],
): ExtractedReceipt | undefined {
  const rawEnvelope = meterless?.receipt_envelope;
  const receiptId = typeof meterless?.receipt_id === "string" ? meterless.receipt_id : undefined;
  if (!rawEnvelope || !receiptId) return undefined;

  const parsed = ReceiptEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
  const result = verifyReceipt(envelope, trustedKeys);
  const body = envelope.body;

  const summary: ReceiptSummary = {
    receipt_id: receiptId,
    decision_id: typeof meterless?.decision_id === "string" ? meterless.decision_id : undefined,
    signer: typeof body.signer === "string" ? body.signer : undefined,
    ts_ms: typeof body.ts_ms === "number" && Number.isInteger(body.ts_ms) && body.ts_ms >= 0 ? body.ts_ms : undefined,
    pubkey_b64: envelope.pubkey_b64,
    sig_b64: envelope.sig_b64,
    body_hash: result.bodyHash ?? sha256Hex(JSON.stringify(body)),
    verification: result.status,
    manifest_hash: typeof body.manifest_hash === "string" ? body.manifest_hash : undefined,
    from_cache: typeof meterless?.from_cache === "boolean" ? meterless.from_cache : undefined,
  };
  return { summary, envelope };
}

const RECEIPT_FILE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Store the full signed envelope under <dir>/receipts/<receipt_id>.json and return its path. */
export function writeReceiptFile(dir: string, receiptId: string, envelope: ReceiptEnvelope): string {
  if (!RECEIPT_FILE_ID.test(receiptId)) {
    throw new AppError("validation", "receipt id is not safe to use as a file name");
  }
  const folder = join(resolve(dir), "receipts");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${receiptId}.json`);
  writeFileSync(file, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o640 });
  return file;
}

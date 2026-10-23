/**
 * Check one exported run folder (eval/runs/<run-id>/) from its own files: every receipt's signature, that every
 * model call in the trace has its receipt, and that the model the trace names is the model the receipt says served
 * the call. Shared by `npm run evidence:verify` and `npm run prove`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyReceipt } from "@sanctions-desk/shared";

interface Envelope {
  pubkey_b64?: string;
  body: { receipt?: { receipt_id?: string; winning_route?: { model?: string; kind?: string } } };
}

export interface RunVerification {
  runId: string;
  /** Receipts with an id (duplicates counted once). */
  receipts: number;
  status: { valid_pinned: number; valid_unpinned: number; invalid: number; malformed: number };
  /** Distinct public keys that signed the receipts. */
  signingKeys: number;
  /** Model calls in the trace that name a receipt. */
  calls: number;
  missing: string[];
  mismatched: string[];
  /** Per step, how many calls each model served. */
  split: Map<string, Map<string, number>>;
}

const lines = (path: string): string[] => gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter(Boolean);

function readReceipts(dir: string, trusted: string[]) {
  const envelopes = new Map<string, Envelope>();
  const keys = new Set<string>();
  const status = { valid_pinned: 0, valid_unpinned: 0, invalid: 0, malformed: 0 };
  for (const l of lines(join(dir, "receipts.jsonl.gz"))) {
    const env = JSON.parse(l) as Envelope;
    status[verifyReceipt(env, trusted).status] += 1;
    if (env.pubkey_b64) keys.add(env.pubkey_b64);
    if (env.body.receipt?.receipt_id) envelopes.set(env.body.receipt.receipt_id, env);
  }
  return { envelopes, keys, status };
}

interface TraceEvent {
  case_id: string;
  agent: string;
  action: string;
  model_used?: string;
  receipt?: { receipt_id?: string };
}

export function verifyExportedRun(dir: string, trusted: string[]): RunVerification {
  const meta = JSON.parse(readFileSync(join(dir, "run-meta.json"), "utf8")) as { run_id: string };
  const { envelopes, keys, status } = readReceipts(dir, trusted);
  const split = new Map<string, Map<string, number>>();
  const missing: string[] = [];
  const mismatched: string[] = [];
  const calls = lines(join(dir, "trace.jsonl.gz"))
    .map((l) => JSON.parse(l) as TraceEvent)
    .filter((e) => e.action === "model_answer" && e.receipt?.receipt_id);
  for (const e of calls) {
    const id = e.receipt?.receipt_id ?? "";
    const env = envelopes.get(id);
    if (!env) {
      missing.push(`${e.case_id} ${id}`);
      continue;
    }
    const served = env.body.receipt?.winning_route?.model ?? "unknown";
    if (e.model_used && e.model_used !== served)
      mismatched.push(`${e.case_id} ${e.agent}: trace says ${e.model_used}, receipt says ${served}`);
    const row = split.get(e.agent) ?? new Map<string, number>();
    row.set(served, (row.get(served) ?? 0) + 1);
    split.set(e.agent, row);
  }
  return {
    runId: meta.run_id,
    receipts: envelopes.size,
    status,
    signingKeys: keys.size,
    calls: calls.length,
    missing,
    mismatched,
    split,
  };
}

/** Problems that make a run fail the check. */
export const problemsIn = (v: RunVerification): number =>
  v.status.invalid + v.status.malformed + v.missing.length + v.mismatched.length;

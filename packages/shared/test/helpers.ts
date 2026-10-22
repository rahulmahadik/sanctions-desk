import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { type Config, canonicalJson, loadConfig, resolveProjectPath } from "../src/index.js";

const dirs: string[] = [];

/** A temp directory that is removed after each test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sanctions-desk-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Config built from the committed defaults plus the given environment. */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ env });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that answers from a queue and records every call. */
export function stubFetch(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: CapturedCall[] = [];
  const queue = [...responses];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error("stubFetch: no response queued");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, calls };
}

export function chatReply(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "chatcmpl-test", model: "answering-model", choices: [{ message: { content } }], ...extra };
}

// ---- policy document editing ---------------------------------------------------------------

export type Json = Record<string, unknown>;

export interface Editor {
  set(path: string, value: unknown): void;
  remove(path: string): void;
  push(path: string, value: unknown): void;
}

function walkTo(root: Json, path: string): { parent: Json | unknown[]; key: string } {
  const keys = path.split(".");
  const last = keys.pop();
  if (last === undefined) throw new Error("empty path");
  let current: unknown = root;
  for (const key of keys) {
    current = (current as Record<string, unknown>)[key];
    if (current === null || typeof current !== "object") throw new Error(`no such path: ${path}`);
  }
  return { parent: current as Json, key: last };
}

/** The committed default policy as plain JSON, optionally edited by path (for example "ownership.thresholdPercent"). */
export function policyJson(edit?: (e: Editor) => void): Json {
  const root = JSON.parse(readFileSync(resolveProjectPath("config/policy.default.json"), "utf8")) as Json;
  edit?.({
    set(path, value) {
      const { parent, key } = walkTo(root, path);
      (parent as Record<string, unknown>)[key] = value;
    },
    remove(path) {
      const { parent, key } = walkTo(root, path);
      delete (parent as Record<string, unknown>)[key];
    },
    push(path, value) {
      const { parent, key } = walkTo(root, path);
      const list = (parent as Record<string, unknown>)[key];
      if (!Array.isArray(list)) throw new Error(`not a list: ${path}`);
      list.push(value);
    },
  });
  return root;
}

/** Throws unless the list has a first element; avoids non-null assertions in tests. */
export function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected a non-empty list");
  return item;
}

// ---- signed receipts ----------------------------------------------------------------------

export interface SignedReceipt {
  envelope: { body: Record<string, unknown>; pubkey_b64: string; sig_b64: string };
  publicKeyB64: string;
}

/** A receipt envelope signed with a fresh Ed25519 key, in the shape Nightshift returns. */
export function signedReceipt(body: Record<string, unknown> = {}): SignedReceipt {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const fullBody = { signer: "meterlessd", ts_ms: 1792682433801, manifest_hash: "m".repeat(64), receipt: {}, ...body };
  const sig = sign(null, Buffer.from(canonicalJson(fullBody), "utf8"), privateKey).toString("base64");
  return { envelope: { body: fullBody, pubkey_b64: publicKeyB64, sig_b64: sig }, publicKeyB64 };
}

/** A Nightshift-style chat response whose `meterless` block carries a signed receipt. */
export function nightshiftReply(
  content: string,
  over: { signed?: SignedReceipt; meterless?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const signed = over.signed ?? signedReceipt();
  return chatReply(content, {
    model: "local-runtime/nemotron",
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    meterless: {
      receipt_id: "rcpt_test_1",
      decision_id: "req_test_1",
      routed_model: "local-runtime/nemotron",
      provider_model: "meterless/fast",
      from_cache: false,
      winning_route: { kind: "local" },
      receipt_envelope: signed.envelope,
      ...over.meterless,
    },
  });
}

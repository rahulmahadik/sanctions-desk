import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { type Config, loadConfig } from "../src/index.js";

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

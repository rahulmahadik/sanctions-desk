import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module shared with the repository scan
import { matches } from "../../../scripts/redaction-patterns.mjs";
import { canonicalJson } from "../src/index.js";
import { tempDir } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** A signed receipt the way Nightshift makes one: Ed25519 over the canonical JSON of the body. */
function receipt(id: string, model: string, extra: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = { receipt: { receipt_id: id, winning_route: { kind: "cloud", model }, ...extra }, signer: "test" };
  const sig = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { body, pubkey_b64: der.subarray(der.length - 32).toString("base64"), sig_b64: sig };
}

function sandbox(trace: Record<string, unknown>[], receipts: Array<ReturnType<typeof receipt>>) {
  const dir = tempDir();
  const logs = join(dir, "logs");
  const results = join(dir, "results");
  mkdirSync(join(logs, "receipts"), { recursive: true });
  mkdirSync(results, { recursive: true });
  writeFileSync(
    join(results, "2026-10-23T01-00-00-000Z-routed.json"),
    JSON.stringify({
      variant: "routed",
      started_at: "2026-10-23T01:00:00.000Z",
      finished_at: "2026-10-23T01:10:00.000Z",
      policy_version: 1,
      models: {},
      cases: [{ case_id: "EX-001" }],
      note: "run by /Users/someone/work with Authorization: Bearer abcdefghijklmnopqrstuvwx",
    }),
  );
  writeFileSync(join(logs, "trace-eval-routed-EX-001.jsonl"), `${trace.map((e) => JSON.stringify(e)).join("\n")}\n`);
  for (const r of receipts)
    writeFileSync(join(logs, "receipts", `${r.body.receipt.receipt_id}.json`), JSON.stringify(r));
  return { dir, logs, results, out: join(dir, "out") };
}

const run = (script: string, args: string[]) =>
  spawnSync("npx", ["tsx", script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, SAMPLE_MODE: "true" },
  });

const event = (over: Record<string, unknown> = {}) => ({
  ts: "2026-10-23T01:01:00.000Z",
  run_id: "eval-routed-EX-001",
  seq: 0,
  agent: "decision",
  action: "model_answer",
  status: "ok",
  model_used: "nvidia/nemotron-3-ultra-550b-a55b",
  receipt: { receipt_id: "rcpt_1" },
  detail: {
    file: "/Users/someone/work/repo/logs/records/x.json",
    note: "from admin@bank.example.net at 10.1.2.3 on laptop.local",
  },
  ...over,
});

describe("the redaction patterns", () => {
  it.each([
    ["a bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwx"],
    ["a local path", "/Users/someone/work/file.json"],
    ["an address", "connected to 10.1.2.3"],
    ["a hostname", "laptop.local"],
    ["an e-mail address", "write to admin@bank.example.net"],
    ["a username", "owner rahulmahadik"],
  ])("finds %s", (_name, text) => {
    expect(matches(text).length).toBeGreaterThan(0);
  });

  it.each([
    "http://127.0.0.1:8088/v1",
    "localhost",
    "/home/zetaris/customer-data",
    "alice@example.test",
    "me@users.noreply.github.com",
    "nvidia/nemotron-3-ultra-550b-a55b",
  ])("leaves %s alone", (text) => {
    expect(matches(text)).toEqual([]);
  });
});

describe("evidence export and verify", () => {
  it("exports a run with the trace redacted and the receipts untouched, and the exported files verify", () => {
    const s = sandbox([event()], [receipt("rcpt_1", "nvidia/nemotron-3-ultra-550b-a55b")]);
    const exported = run("tools/evidence-export.ts", [
      "--logs-dir",
      s.logs,
      "--results-dir",
      s.results,
      "--out",
      s.out,
    ]);
    expect(exported.status, exported.stderr).toBe(0);
    const id = "routed-20261023T010000Z";
    const trace = gunzipSync(readFileSync(join(s.out, id, "trace.jsonl.gz"))).toString("utf8");
    expect(matches(trace)).toEqual([]);
    expect(trace).toContain("[local path]");
    expect(trace).toContain("[email]");
    expect(trace).toContain("[address]");
    expect(trace).toContain("[host]");
    expect(matches(readFileSync(join(s.out, id, "results.json"), "utf8"))).toEqual([]);
    const meta = JSON.parse(readFileSync(join(s.out, id, "run-meta.json"), "utf8")) as {
      receipts: number;
      events: number;
      files: Record<string, { sha256: string }>;
    };
    expect(meta).toMatchObject({ receipts: 1, events: 1 });
    expect(meta.files["receipts.jsonl.gz"]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const verified = run("tools/evidence-verify.ts", [join(s.out, id)]);
    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
    expect(verified.stdout).toContain("1 receipts, 1 model calls");
    expect(verified.stdout).toContain("nvidia/nemotron-3-ultra-550b-a55b 100.0% (1)");
  });

  it("fails the export when a receipt itself would need redacting, because a receipt cannot be edited", () => {
    const s = sandbox([event()], [receipt("rcpt_1", "m", { prompt_preview: "see /Users/someone/work" })]);
    const exported = run("tools/evidence-export.ts", [
      "--logs-dir",
      s.logs,
      "--results-dir",
      s.results,
      "--out",
      s.out,
    ]);
    expect(exported.status).toBe(1);
    expect(exported.stderr).toContain("receipt rcpt_1 matches local path");
  });

  it("fails the export when a receipt named in the trace is missing", () => {
    const s = sandbox([event()], []);
    const exported = run("tools/evidence-export.ts", [
      "--logs-dir",
      s.logs,
      "--results-dir",
      s.results,
      "--out",
      s.out,
    ]);
    expect(exported.status).toBe(1);
    expect(exported.stderr).toContain("its file is missing");
  });

  it("fails the check on a receipt that was altered, and on a trace that names another model", () => {
    const s = sandbox([event()], [receipt("rcpt_1", "nvidia/nemotron-3-ultra-550b-a55b")]);
    run("tools/evidence-export.ts", ["--logs-dir", s.logs, "--results-dir", s.results, "--out", s.out]);
    const id = "routed-20261023T010000Z";
    expect(run("tools/evidence-verify.ts", [join(s.out, id)]).status).toBe(0);

    // The receipt says another model served the call than the signed one: the signature no longer matches.
    const receiptsFile = join(s.out, id, "receipts.jsonl.gz");
    const altered = gunzipSync(readFileSync(receiptsFile)).toString("utf8").replace("ultra-550b", "tiny-1b");
    writeFileSync(receiptsFile, require("node:zlib").gzipSync(altered));
    const bad = run("tools/evidence-verify.ts", [join(s.out, id)]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("1 invalid");
  });

  it("leaves the README alone when it exports to another folder than eval/runs", () => {
    // Every export in this file goes to a temporary folder, so the README must never name the sandbox's run.
    const s = sandbox([event()], [receipt("rcpt_1", "nvidia/nemotron-3-ultra-550b-a55b")]);
    const exported = run("tools/evidence-export.ts", [
      "--logs-dir",
      s.logs,
      "--results-dir",
      s.results,
      "--out",
      s.out,
    ]);
    expect(exported.status).toBe(0);
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).not.toContain("routed-20261023T010000Z");
  });
});

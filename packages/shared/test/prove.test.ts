import { describe, expect, it } from "vitest";
import {
  type CheckResult,
  countSecrets,
  exitCodeFor,
  formatLine,
  proveMarkdown,
  type RunInfo,
  readmeBlock,
  redact,
  replaceBlock,
  runCheck,
  sampleEnv,
  summaryLine,
} from "../../../tools/lib/prove.js";

const result = (name: string, status: "PASS" | "FAIL", detail = "detail"): CheckResult => ({
  name,
  status,
  detail,
  ms: 1234,
  output: "",
});
const info: RunInfo = {
  time: "2026-10-24T01:02:03.000Z",
  commit: "abc1234",
  dirty: false,
  node: "v24.0.0",
  platform: "linux-x64",
  fresh: false,
};

describe("the PASS/FAIL list", () => {
  it("prints one line per check with its status, detail and time", () => {
    expect(formatLine(result("Preregistration", "PASS", "hashes match"))).toBe(
      "PASS  Preregistration: hashes match (1.2 s)",
    );
    expect(formatLine(result("Signed evidence", "FAIL", "2 invalid"))).toBe("FAIL  Signed evidence: 2 invalid (1.2 s)");
  });

  it("summarises how many passed and names the ones that failed", () => {
    expect(summaryLine([result("A", "PASS"), result("B", "PASS")])).toBe("PASS: 2 of 2 checks passed");
    expect(summaryLine([result("A", "PASS"), result("B", "FAIL"), result("C", "FAIL")])).toBe(
      "FAIL: 1 of 3 checks passed; failed: B, C",
    );
    expect(summaryLine([])).toBe("FAIL: no checks ran");
  });

  it("exits 0 only when every check passed, and 1 otherwise or when nothing ran", () => {
    expect(exitCodeFor([result("A", "PASS"), result("B", "PASS")])).toBe(0);
    expect(exitCodeFor([result("A", "PASS"), result("B", "FAIL")])).toBe(1);
    expect(exitCodeFor([])).toBe(1);
  });
});

describe("running a check", () => {
  it("turns a throw into a FAIL with the message", async () => {
    const r = await runCheck({
      name: "Boom",
      timeoutMs: 1000,
      run: async () => {
        throw new Error("no such file");
      },
    });
    expect(r).toMatchObject({ name: "Boom", status: "FAIL", detail: "error: no such file" });
  });

  it("fails a check that does not finish in time", async () => {
    const r = await runCheck({ name: "Slow", timeoutMs: 20, run: () => new Promise(() => {}) });
    expect(r).toMatchObject({ status: "FAIL", detail: "timed out after 0 s" });
  });

  it("passes a check that reports ok, and masks a credential in what it printed", async () => {
    const token = `Bearer ${"a1".repeat(16)}`;
    const r = await runCheck({
      name: "Ok",
      timeoutMs: 1000,
      run: async () => ({ ok: true, detail: "fine", output: token }),
    });
    expect(r.status).toBe("PASS");
    expect(r.output).toBe("[bearer token removed]");
  });
});

describe("what --write produces", () => {
  const results = [result("A", "PASS", "one"), result("B", "FAIL", "two")];

  it("writes the time, commit and every line to eval/PROVE.md", () => {
    const md = proveMarkdown({ ...info, dirty: true }, results);
    expect(md).toContain("Machine time: 2026-10-24T01:02:03.000Z");
    expect(md).toContain("Commit: abc1234 (with uncommitted changes)");
    expect(md).toContain("PASS  A: one (1.2 s)\nFAIL  B: two (1.2 s)\nFAIL: 1 of 2 checks passed; failed: B");
  });

  it("replaces only what is between the README markers", () => {
    const readme = "top\n<!-- prove:start -->\nstale list\n<!-- prove:end -->\nbottom\n";
    const out = replaceBlock(readme, readmeBlock(info, results));
    expect(out.startsWith("top\n<!-- prove:start -->\n**One-command proof**")).toBe(true);
    expect(out).toContain("npm ci && npm run prove");
    expect(out).not.toContain("stale list");
    expect(out.endsWith("<!-- prove:end -->\nbottom\n")).toBe(true);
    expect(() => replaceBlock("no markers", "x")).toThrow(/markers/);
  });
});

describe("secrets", () => {
  it("counts credential-bearing URLs, private keys and tokens, and ignores placeholders", () => {
    const text = [
      `postgres://desk:${"s3cr3tvalue"}@db.example.com:5432/bank`,
      `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}`,
      `api_key=${"Z".repeat(32)}`,
      `postgres://desk:${"$"}{BANKDB_PASSWORD}@localhost:5432/bank`,
      "ZETARIS_API_KEY=",
      "http://localhost:8888/api/v1.0",
    ].join("\n");
    expect(Object.fromEntries(countSecrets(text))).toEqual({
      "credential in a URL": 1,
      "private key": 1,
      "key or token assignment": 1,
    });
    expect(redact(text)).not.toContain("s3cr3tvalue");
  });

  it("gives child checks sample mode and none of the caller's keys", () => {
    const env = sampleEnv({ PATH: "/bin", HOME: "/h", ZETARIS_API_KEY: "k", METERLESS_RUNTIME_TOKEN: "t" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", SAMPLE_MODE: "true", AUTH_MODE: "demo" });
    expect(env.ZETARIS_API_KEY).toBeUndefined();
    expect(env.METERLESS_RUNTIME_TOKEN).toBeUndefined();
  });
});

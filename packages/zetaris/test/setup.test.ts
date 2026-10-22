import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillPlaceholders, parseStatements, runSetup } from "../src/setup.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const SCRIPT = `-- header comment
-- @@ first
CREATE NAMESPACE IF NOT EXISTS a.b;

-- @@ second
-- a comment inside
COMPILE USL m DEPLOY NAMESPACE a.b DDL
CREATE TABLE t (
  id int
);
CREATE TABLE u (
  id int
);
`;

describe("parseStatements", () => {
  it("splits on markers, drops comment lines and the final semicolon, keeps inner ones", () => {
    const statements = parseStatements(SCRIPT);
    expect(statements.map((s) => s.name)).toEqual(["first", "second"]);
    expect(statements[0]?.sql).toBe("CREATE NAMESPACE IF NOT EXISTS a.b");
    expect(statements[1]?.sql).toContain("CREATE TABLE t (\n  id int\n);\nCREATE TABLE u");
    expect(statements[1]?.sql.endsWith(")")).toBe(true);
    expect(statements[1]?.sql).not.toContain("a comment");
  });
  it("rejects empty and duplicate statements", () => {
    expect(() => parseStatements("-- @@ a\n\n-- @@ b\nSELECT 1")).toThrow(/empty/);
    expect(() => parseStatements("-- @@ a\nSELECT 1\n-- @@ a\nSELECT 2")).toThrow(/used twice/);
  });
  it("reads the committed setup scripts", () => {
    const read = (file: string) => readFileSync(new URL(`../../../zetaris/sql/${file}`, import.meta.url), "utf8");
    expect(parseStatements(read("05_usl_create.sql")).map((s) => s.name)).toContain("compile_model");
    expect(parseStatements(read("06_activate_create.sql")).map((s) => s.name)).toContain("activate_alert");
    expect(parseStatements(read("07_dq_create.sql")).map((s) => s.name)).toContain("dq_dob_present_for_individuals");
  });
});

/** A placeholder as written in a setup script: dollar sign, brace, NAME, brace. */
const ph = (name: string): string => `$\u007b${name}}`;

describe("fillPlaceholders", () => {
  it("substitutes environment values and lists the names it used", () => {
    expect(fillPlaceholders(`user ${ph("DB_USER")} pw ${ph("DB_PASS")}`, { DB_USER: "u", DB_PASS: "p" })).toEqual({
      sql: "user u pw p",
      used: ["DB_USER", "DB_PASS"],
    });
  });
  it("fails when a value is missing", () => {
    expect(() => fillPlaceholders(ph("NOPE"), {})).toThrow(/NOPE is not set/);
  });
});

describe("runSetup", () => {
  const statements = parseStatements(SCRIPT);

  it("lists statements without sending anything unless applying", async () => {
    const api = fakeZetaris(() => ({ body: rowsOf([], []) }));
    const results = await runSetup({
      config: testConfig({ ZETARIS_API_KEY: "k" }),
      statements,
      fetchImpl: api.fetchImpl,
    });
    expect(results.map((r) => r.outcome)).toEqual(["dry_run", "dry_run"]);
    expect(api.sent).toHaveLength(0);
  });

  it("sends each statement with the admin key and logs it", async () => {
    const api = fakeZetaris(() => ({ body: rowsOf(["x"], [["1"]]) }));
    const logFile = join(mkdtempSync(join(tmpdir(), "zsetup-")), "log", "setup.jsonl");
    const seen: string[] = [];
    const results = await runSetup({
      config: testConfig({ ZETARIS_API_KEY: "admin-1" }),
      statements,
      apply: true,
      logFile,
      fetchImpl: api.fetchImpl,
      onResult: (r) => seen.push(r.name),
    });
    expect(results.map((r) => [r.outcome, r.rows, r.preview])).toEqual([
      ["applied", 1, '[["1"]]'],
      ["applied", 1, '[["1"]]'],
    ]);
    expect(api.sent[0]?.headers.Authorization).toBe("Bearer admin-1");
    expect(seen).toEqual(["first", "second"]);
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ name: "first", mode: "apply", outcome: "applied" });
    expect(JSON.stringify(lines)).not.toContain("admin-1");
  });

  it("skips 'already exists' answers when asked, and stops at the first real failure", async () => {
    let n = 0;
    const api = fakeZetaris(() => {
      n += 1;
      return n === 1
        ? { status: 400, body: { msg: "namespace a.b is already existing" } }
        : { status: 400, body: { msg: "boom" } };
    });
    const config = testConfig({ ZETARIS_API_KEY: "k" });
    const results = await runSetup({ config, statements, apply: true, skipExists: true, fetchImpl: api.fetchImpl });
    expect(results.map((r) => r.outcome)).toEqual(["skipped_exists", "failed"]);
    expect(results[1]?.error).toBe("boom");
    n = 0;
    const strict = await runSetup({ config, statements, apply: true, fetchImpl: api.fetchImpl });
    expect(strict.map((r) => r.outcome)).toEqual(["failed"]);
  });

  it("also treats removing something that is already gone as fine when run again", async () => {
    const api = fakeZetaris(() => ({
      status: 400,
      body: { msg: "metastore.sanctions.screening_usl is not existing" },
    }));
    const drops = parseStatements("-- @@ remove\nREMOVE USL x NAMESPACE a.b\n\n-- @@ create\nCREATE ROLE 'r'");
    const config = testConfig({ ZETARIS_API_KEY: "k" });
    const results = await runSetup({
      config,
      statements: drops,
      apply: true,
      skipExists: true,
      fetchImpl: api.fetchImpl,
    });
    // The removal is skipped; the create (a different kind of statement) is a real failure.
    expect(results.map((r) => r.outcome)).toEqual(["skipped_exists", "failed"]);
  });

  it("needs the admin key to apply", async () => {
    await expect(runSetup({ config: testConfig(), statements, apply: true })).rejects.toMatchObject({
      type: "config_missing",
    });
  });
});

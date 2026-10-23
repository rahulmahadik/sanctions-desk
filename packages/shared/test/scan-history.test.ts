import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../../../scripts/scan-history.mjs", import.meta.url));
/** Joins fragments so this file never contains the phrases it tests for. */
const text = (...fragments: string[]): string => fragments.join("");

interface Commit {
  message: string;
  files: Record<string, string>;
}

/** Build a throwaway repository from the given commits and scan its history. */
function scan(commits: Commit[], extra: string[] = []) {
  const dir = tempDir();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q");
  for (const c of commits) {
    for (const [name, body] of Object.entries(c.files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), body);
      git("add", name);
    }
    git("commit", "-q", "-m", c.message);
  }
  const run = spawnSync("node", [SCRIPT, ...extra], { cwd: dir, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("scan:history", () => {
  it("passes a clean history", () => {
    const { status, output } = scan([{ message: "Add the parser", files: { "a.md": "Plain text.\n" } }]);
    expect(status).toBe(0);
    expect(output).toContain("scan:history ok (1 commits");
  });

  it("finds wording in a commit message even when the files are clean", () => {
    const { status, output } = scan([{ message: text("Mile", "stone one: start"), files: { "a.md": "ok\n" } }]);
    expect(status).toBe(1);
    expect(output).toContain("message:");
  });

  it("finds a line that was added and later removed", () => {
    const { status, output } = scan([
      { message: "Add notes", files: { "a.md": text("see inter", "nal/brief\n") } },
      { message: "Remove notes", files: { "a.md": "clean\n" } },
    ]);
    expect(status).toBe(1);
    expect(output).toContain("a.md: internal brief path");
  });

  it("finds paths that must never be committed, even if deleted later", () => {
    const { status, output } = scan([
      { message: "Add a file", files: { ".env": "X=1\n" } },
      { message: "Add notes", files: { [text("inter", "nal/plan.md")]: "x\n" } },
    ]);
    expect(status).toBe(1);
    expect(output).toContain("path: environment file");
    expect(output).toContain("path: internal notes");
  });

  it("flags a key-like value without printing it, but not made-up secrets in test files", () => {
    const key = "A".repeat(40);
    const bad = scan([{ message: "Add config", files: { "config.json": `{"apiKey": "${key}"}\n` } }]);
    expect(bad.status).toBe(1);
    expect(bad.output).toContain("possible secret");
    expect(bad.output).not.toContain(key);
    const fixture = scan([
      { message: "Add test", files: { "pkg/test/redact.test.ts": `const k = "Bearer ${key}";\n` } },
    ]);
    expect(fixture.status).toBe(0);
  });

  it("can scan one revision range", () => {
    const { status } = scan([{ message: "Add the parser", files: { "a.md": "ok\n" } }], ["HEAD"]);
    expect(status).toBe(0);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../../../scripts/lint-voice.mjs", import.meta.url));

/** Run the voice lint in a throwaway git repository that tracks one file with the given text. */
function lint(text: string, name = "note.md") {
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, name), text);
  git("add", name);
  const run = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** Joins fragments so this file never contains the phrases it tests for. */
const text = (...fragments: string[]): string => fragments.join("");

describe("lint:voice", () => {
  it("passes ordinary technical text", () => {
    const { status, output } = lint("The API validates every request and returns a structured error.\n");
    expect(status).toBe(0);
    expect(output).toContain("lint:voice ok");
  });

  it.each([
    ["tracking word", text("This is planned for mile", "stone four.")],
    ["tracking number", text("Finished in M", "3 already.")],
    ["status wording", text("This part is work in ", "progress.")],
    ["work marker", text("// TO", "DO tidy this up")],
    ["internal path", text("see inter", "nal/brief for the rest")],
    ["assistant attribution", text("Written with Cla", "ude")],
  ])("rejects %s", (_name, line) => {
    const { status, output } = lint(`${line}\n`);
    expect(status).toBe(1);
    expect(output).toContain("lint:voice found");
  });

  it.each([
    text("Ask the brow", "ser assistant to look it up."),
    text("BROW", "SER CHECK: find the licence"),
    text("Use Cla", "ude in Chrome for this."),
    text("Do a brow", "ser check first."),
    text("brow", "ser-check request format"),
    text("Brow", "ser Assistant"),
  ])("rejects research-process wording: %s", (line) => {
    const { status, output } = lint(`${line}\n`);
    expect(status).toBe(1);
    expect(output).toContain("research process wording");
  });

  it("allows the tool disclosure in the README and metadata.json only", () => {
    const line = text("Built with an AI coding assistant (Cla", "ude Code).\n");
    expect(lint(line, "README.md").status).toBe(0);
    expect(lint(line, "metadata.json").status).toBe(0);
    expect(lint(line, "docs.md").status).toBe(1);
    // Attribution lines are never allowed, not even there.
    expect(lint(text("Co-Authored", "-By: someone\n"), "README.md").status).toBe(1);
  });

  it("only checks tracked text files", () => {
    const { status } = lint(text("BROW", "SER CHECK"), "image.png");
    expect(status).toBe(0);
  });
});

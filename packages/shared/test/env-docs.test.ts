import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";

const root = projectRoot();
const SOURCE_DIRS = ["packages", "apps", "tools", "scripts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "coverage") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mjs)$/.test(name) && !/\.test\.ts$/.test(name) && !path.includes("/engines/conformance/")
      ? [path]
      : [];
  });
}

/** Names read from the environment by the code, whether through `process.env.X` or the config table. */
function envNamesInCode(): string[] {
  const names = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(join(root, dir))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|env: "([A-Z][A-Z0-9_]+)"/g)) {
        names.add((m[1] ?? m[2]) as string);
      }
    }
  }
  // Variables of the operating system, read only to pass them on to a child process, are not configuration.
  for (const system of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"]) names.delete(system);
  return [...names].sort();
}

describe("environment variables are documented", () => {
  const names = envNamesInCode();
  const example = readFileSync(join(root, ".env.example"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");

  it("finds the variables the code reads", () => {
    expect(names).toContain("ZETARIS_API_KEY");
    expect(names.length).toBeGreaterThan(15);
  });

  it.each(names)("%s is in .env.example and in the README", (name) => {
    expect(example).toMatch(new RegExp(`^${name}=`, "m"));
    // The README groups related names, e.g. `ZETARIS_TOKEN_EVIDENCE`, `_REVIEWER`, `_EVAL`.
    const last = name.slice(name.lastIndexOf("_"));
    expect(readme.includes(name) || readme.includes(`\`${last}\``)).toBe(true);
  });

  it("keeps placeholders only and drops the retired model variable", () => {
    expect(example).not.toMatch(/^METERLESS_MODEL=/m);
    expect(example).not.toMatch(/[A-Za-z0-9+/]{40,}/);
  });

  it("loads as a valid configuration when copied to .env as it is", () => {
    const env: Record<string, string> = {};
    for (const line of example.split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m && m[2] !== "") env[m[1] as string] = m[2] as string;
    }
    const config = loadConfig({ env });
    expect(config.sampleMode).toBe(true);
  });
});

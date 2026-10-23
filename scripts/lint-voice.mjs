#!/usr/bin/env node
/**
 * Checks the voice of everything that is committed. The repository is public, so committed text must
 * not contain work-tracking wording, internal paths or assistant attribution.
 *
 *   npm run lint:voice
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { RULES, SKIP_FILES, SKIP_PREFIXES, TEXT_EXTENSIONS } from "./voice-rules.mjs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];

for (const file of tracked) {
  if (SKIP_FILES.has(file) || SKIP_PREFIXES.some((p) => file.startsWith(p)) || !TEXT_EXTENSIONS.has(extname(file)))
    continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line) && !rule.allowedIn?.has(file))
        problems.push(`${file}:${index + 1}  ${rule.name}: ${line.trim().slice(0, 100)}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`lint:voice found ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`lint:voice ok (${tracked.length} tracked files checked)`);

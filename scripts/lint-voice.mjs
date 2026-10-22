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

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".py",
  ".toml",
  ".txt",
]);
const SKIP_FILES = new Set(["package-lock.json", "uv.lock", "LICENSE", "scripts/lint-voice.mjs"]);

const RULES = [
  { name: "milestone wording", pattern: /\bmilestones?\b/i },
  { name: "milestone number (M0 to M9)", pattern: /(^|[^A-Za-z0-9_])M[0-9]\b/ },
  { name: "work-in-progress wording", pattern: /work[- ]in[- ]progress|not (built|implemented) yet|coming soon/i },
  { name: "work marker (TODO, FIXME, XXX)", pattern: /\b(TODO|FIXME|XXX)\b/ },
  { name: "internal brief path", pattern: /internal\/brief|\binternal\/(?!$)/ },
  { name: "assistant attribution", pattern: /\bClaude\b|Co-Authored-By|Generated (with|by)|\bAnthropic\b/i },
];

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];

for (const file of tracked) {
  if (SKIP_FILES.has(file) || !TEXT_EXTENSIONS.has(extname(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) problems.push(`${file}:${index + 1}  ${rule.name}: ${line.trim().slice(0, 100)}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`lint:voice found ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`lint:voice ok (${tracked.length} tracked files checked)`);

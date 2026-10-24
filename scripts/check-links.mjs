#!/usr/bin/env node
/**
 * Check every relative link, image and #anchor in the tracked Markdown files: the file or folder must exist, and an
 * anchor must match a heading (GitHub's slug rules, with -1, -2 for repeats) or an explicit id in the target file.
 * External links (http, https, mailto) are not fetched. Exits 1 and lists each miss.
 *
 *   node scripts/check-links.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

/** Lines outside fenced code blocks, with inline code removed. */
function proseLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      out.push("");
      continue;
    }
    out.push(fence === null ? line.replace(/`[^`]*`/g, "``") : "");
  }
  return out;
}

/** GitHub's heading slug: the rendered text, lower case, punctuation removed, spaces to hyphens. */
export function slug(heading) {
  const text = heading
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*|__|\*/g, "")
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\p{M} _-]/gu, "").replace(/ /g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = readFileSync(join(root, file), "utf8");
  const seen = new Map();
  const anchors = new Set();
  for (const line of proseLines(text)) {
    const h = line.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function targetsIn(line) {
  const found = [];
  for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) found.push(m[1]);
  for (const m of line.matchAll(/\b(?:src|href)="([^"]+)"/g)) found.push(m[1]);
  return found;
}

/** Why a relative target from `file` does not resolve, or null when it does. */
function problemWith(file, target) {
  const [rawPath, anchor] = target.split("#", 2);
  const path = decodeURIComponent(rawPath ?? "");
  const resolved = path === "" ? file : normalize(join(dirname(file), path));
  if (relative(root, join(root, resolved)).startsWith("..")) return `${target} points outside the repository`;
  if (!existsSync(join(root, resolved))) return `${target} (no such file: ${resolved})`;
  if (!anchor || !resolved.endsWith(".md") || statSync(join(root, resolved)).isDirectory()) return null;
  return anchorsOf(resolved).has(decodeURIComponent(anchor))
    ? null
    : `${target} (no heading #${anchor} in ${resolved})`;
}

const misses = [];
let checked = 0;
for (const file of files) {
  const lines = proseLines(readFileSync(join(root, file), "utf8"));
  lines.forEach((line, i) => {
    for (const target of targetsIn(line)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      checked += 1;
      const problem = problemWith(file, target);
      if (problem) misses.push(`${file}:${i + 1}: ${problem}`);
    }
  });
}

if (misses.length > 0) {
  console.error(`check-links: ${misses.length} broken link(s) in ${files.length} Markdown files:`);
  for (const m of misses) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`check-links: ${checked} relative links and anchors in ${files.length} Markdown files resolve`);

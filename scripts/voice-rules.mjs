/**
 * The wording rules shared by `npm run lint:voice` (files that are committed now) and
 * `npm run scan:history` (every commit message and every added line in the history).
 */
export const TEXT_EXTENSIONS = new Set([
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
export const SKIP_FILES = new Set([
  "package-lock.json",
  "uv.lock",
  "LICENSE",
  "scripts/lint-voice.mjs",
  "scripts/voice-rules.mjs",
  "scripts/scan-public.mjs",
]);
// Rows copied from public sanctions lists and GLEIF are data, not our wording.
export const SKIP_PREFIXES = ["data/sample/", "data/reference/", "packages/engines/conformance/"];

export const RULES = [
  { name: "milestone wording", pattern: /\bmilestones?\b/i },
  { name: "milestone number (M0 to M9)", pattern: /(^|[^A-Za-z0-9_])M[0-9]\b/ },
  { name: "work-in-progress wording", pattern: /work[- ]in[- ]progress|not (built|implemented) yet|coming soon/i },
  { name: "work marker (TODO, FIXME, XXX)", pattern: /\b(TODO|FIXME|XXX)\b/ },
  { name: "internal brief path", pattern: /internal\/brief|\binternal\/(?!$)/ },
  { name: "research process wording", pattern: /browser[- ]?(assistant|check)|claude in chrome/i },
  { name: "assistant attribution line", pattern: /Co-Authored-By|Generated (with|by)/i },
  // The tools used to build the project are disclosed in the README, in metadata.json and in the sponsor write-up, and nowhere else.
  {
    name: "assistant name",
    pattern: /\bClaude\b|\bAnthropic\b/i,
    allowedIn: new Set(["README.md", "metadata.json", "docs/SPONSORS.md"]),
  },
];

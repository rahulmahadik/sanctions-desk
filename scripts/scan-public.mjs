#!/usr/bin/env node
/**
 * A broader review of what a public reader would see, run over every tracked file, every commit message and the
 * lines every commit added. It looks for internal discussion or instruction-style wording, references to briefs or
 * prompts, assistant names or attribution, local paths, usernames, e-mail addresses, secrets, and folders that must
 * never be tracked. It only reports; nothing is changed.
 *
 *   npm run scan:public            findings by group, for tracked files and for the history
 *   npm run scan:public -- --json  the same as JSON
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { gunzipSync } from "node:zlib";
import { matches, USERNAME } from "./redaction-patterns.mjs";
import { SKIP_FILES, SKIP_PREFIXES, TEXT_EXTENSIONS } from "./voice-rules.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
const asJson = process.argv.includes("--json");

const RULES = [
  {
    group: "instruction-style wording",
    re: /\b(as instructed|we decided|per (the )?request|the user (asked|said|wants|told)|as requested|per the brief|as per (the )?(instructions|brief)|you asked|task list)\b/i,
  },
  {
    group: "brief, prompt or event references",
    re: /\b(hackathon (brief|prompt)|the brief|judging criteria|prize|competitors?|submission (deadline|form)|HackOS)\b/i,
  },
  {
    group: "assistant name or attribution",
    re: /\b(Claude|Anthropic|Claude Code|Co-Authored-By|Generated (with|by)|AI-generated)\b/i,
    allowedIn: new Set(["README.md", "metadata.json", "LICENSE"]),
  },
  {
    group: "local path",
    re: /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Z]:\\Users\\|\/private\/tmp|\/var\/folders)/,
  },
  { group: "username", re: new RegExp(USERNAME.source, "i") },
  {
    group: "e-mail address",
    re: /\b[\w.+-]+@(?!example\.(com|org)|sanctions-desk\.local|users\.noreply\.github\.com)[\w-]+\.[\w.-]+\b/,
  },
  {
    group: "work-tracking wording",
    re: /(\b(milestones?|TODO|FIXME|XXX|work[- ]in[- ]progress|coming soon)\b|(^|[^A-Za-z0-9_])M[0-9]\b)/,
  },
  {
    group: "possible secret",
    re: /(Bearer\s+[A-Za-z0-9._~+/-]{24,}|\b(api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{28,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i,
    skipTests: true,
  },
];
const FORBIDDEN_PATHS = [
  { group: "internal or private folder tracked", re: /^(internal|\.local|\.claude)\// },
  { group: "assistant instruction file tracked", re: /(^|\/)CLAUDE\.md$/ },
  { group: "environment file tracked", re: /(^|\/)\.env($|\.(?!example$))/ },
  { group: "raw data or logs tracked", re: /^(data\/(raw|normalised)|logs)\// },
];

// Files without a text extension that a public reader sees all the same.
const EXTRA_TEXT = new Set(["Dockerfile", "LICENSE", ".gitignore", ".dockerignore", ".env.example"]);
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf"]);
const readable = (f) => EXTRA_TEXT.has(f) || TEXT_EXTENSIONS.has(extname(f));
const RULE_FILES = new Set(["scripts/scan-public.mjs", "scripts/scan-history.mjs"]);
const skipped = (f) =>
  RULE_FILES.has(f) || (SKIP_FILES.has(f) && !EXTRA_TEXT.has(f)) || SKIP_PREFIXES.some((p) => f.startsWith(p));

const findings = { tracked: [], history: [], messages: [], paths: [], images: [] };
const allowed = (rule, file) => rule.allowedIn?.has(file);
const test = (file) => /(^|\/)test\//.test(file);

// 1. Tracked files now.
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
for (const file of tracked) {
  for (const f of FORBIDDEN_PATHS) if (f.re.test(file)) findings.paths.push({ where: "tracked", group: f.group, file });
  if (IMAGES.has(extname(file).toLowerCase()))
    findings.images.push({ group: "image or document to review by eye", file });
  if (skipped(file) || !readable(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const r of RULES) {
      if (r.re.test(line) && !allowed(r, file) && !(r.skipTests && test(file)))
        findings.tracked.push({ group: r.group, file, line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
}

// 1b. Exported run evidence is compressed; look inside it with the same patterns the export used.
for (const file of tracked.filter((f) => /^eval\/(runs|studies)\/.+\.gz$/.test(f))) {
  gunzipSync(readFileSync(file))
    .toString("utf8")
    .split("\n")
    .forEach((line, i) => {
      // Receipts are signed and cannot be edited, so only the trace and results are held to the redaction patterns.
      if (file.endsWith("receipts.jsonl.gz")) return;
      for (const m of matches(line))
        findings.tracked.push({ group: `exported evidence: ${m}`, file, line: i + 1, text: line.slice(0, 80) });
    });
}

// 2. Commit messages.
for (const entry of git(["log", "--all", "--format=%H%x1f%an%x1f%ae%x1f%B%x1e"])
  .split("\x1e")
  .filter((m) => m.trim())) {
  const [hash, an, ae, ...body] = entry.trim().split("\x1f");
  const msg = body.join("\x1f");
  for (const line of msg.split("\n")) {
    for (const r of RULES)
      if (r.re.test(line) && r.group !== "possible secret")
        findings.messages.push({ group: r.group, commit: hash.slice(0, 10), text: line.trim().slice(0, 120) });
  }
  findings.messages.push({ group: "commit author", commit: hash.slice(0, 10), text: `${an} <${ae}>`, info: true });
}

// 3. History: paths ever touched and lines ever added.
let current = "";
for (const line of git(["log", "--all", "--name-only", "--format=COMMIT %H"]).split("\n")) {
  if (line.startsWith("COMMIT ")) current = line.slice(7, 17);
  else if (line)
    for (const f of FORBIDDEN_PATHS)
      if (f.re.test(line)) findings.paths.push({ where: "history", group: f.group, file: line, commit: current });
}
let file = "";
let skip = true;
for (const line of git(["log", "--all", "-p", "--no-color", "--no-ext-diff", "--format=COMMIT %H", "-U0"]).split(
  "\n",
)) {
  if (line.startsWith("COMMIT ")) current = line.slice(7, 17);
  else if (line.startsWith("+++ ")) {
    file = line.startsWith("+++ b/") ? line.slice(6) : "";
    skip = !file || skipped(file) || !readable(file);
  } else if (line.startsWith("+") && !skip) {
    const text = line.slice(1);
    for (const r of RULES) {
      if (r.re.test(text) && !allowed(r, file) && !(r.skipTests && test(file)))
        findings.history.push({ group: r.group, commit: current, file, text: text.trim().slice(0, 120) });
    }
  }
}

// Only what is no longer in the tracked files counts as history-only.
const stillThere = new Set(findings.tracked.map((f) => `${f.file}|${f.text}`));
findings.history = findings.history.filter((f) => !stillThere.has(`${f.file}|${f.text}`));

if (asJson) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  const show = (title, rows, fmt) => {
    console.log(`\n== ${title}: ${rows.length}`);
    const by = Object.groupBy(rows, (r) => r.group);
    for (const [g, list] of Object.entries(by)) {
      console.log(`  ${g}: ${list.length}`);
      for (const r of list.slice(0, 12)) console.log(`    ${fmt(r)}`);
      if (list.length > 12) console.log(`    ... and ${list.length - 12} more`);
    }
  };
  show("tracked files now", findings.tracked, (r) => `${r.file}:${r.line}  ${r.text}`);
  show("images and documents (check by eye for local paths, usernames or tool names)", findings.images, (r) => r.file);
  show("paths", findings.paths, (r) => `[${r.where}] ${r.file}${r.commit ? ` (${r.commit})` : ""}`);
  show(
    "commit messages",
    findings.messages.filter((m) => !m.info),
    (r) => `${r.commit}  ${r.text}`,
  );
  console.log(
    `\n== commit authors: ${[...new Set(findings.messages.filter((m) => m.info).map((m) => m.text))].join("; ")}`,
  );
  show("history only (added once, since removed)", findings.history, (r) => `${r.commit}  ${r.file}  ${r.text}`);
}

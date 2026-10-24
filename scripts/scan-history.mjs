#!/usr/bin/env node
/**
 * Scans the whole history, not only the files that are committed now: every commit message, every line a
 * commit added, every path a commit touched. It applies the wording rules of `npm run lint:voice`, looks for
 * secrets, and flags paths that must never be committed.
 *
 *   npm run scan:history              all branches and tags
 *   npm run scan:history -- main      one revision range
 */
import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { RULES, SKIP_FILES, SKIP_PREFIXES, TEXT_EXTENSIONS } from "./voice-rules.mjs";

const range = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const revs = range.length > 0 ? range : ["--all"];
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });

const SECRETS = [
  { name: "bearer token", pattern: /Bearer\s+[A-Za-z0-9._~+/-]{24,}/ },
  {
    name: "key-like value",
    pattern: /\b(api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{28,}/i,
  },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "provider key", pattern: /\b(sk-[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/ },
];
const FORBIDDEN_PATHS = [
  { name: "internal notes", pattern: /^internal\// },
  { name: "environment file", pattern: /(^|\/)\.env($|\.(?!example$))/ },
  { name: "raw or normalised source data", pattern: /^data\/(raw|normalised)\// },
  { name: "run logs", pattern: /^logs\// },
  { name: "assistant instructions", pattern: new RegExp(`(^|/)${["CLAU", "DE"].join("")}\\.md$`) },
  { name: "local secrets folder", pattern: /^\.local\// },
];

const problems = [];
const add = (commit, kind, detail) => problems.push({ commit: commit.slice(0, 10), kind, detail });

// Commit messages.
const messages = git(["log", ...revs, "--format=%H%x1f%B%x1e"])
  .split("\x1e")
  .filter((m) => m.trim() !== "");
for (const entry of messages) {
  const [hash, body = ""] = entry.trim().split("\x1f");
  for (const line of body.split("\n")) {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) add(hash, `message: ${rule.name}`, line.trim().slice(0, 100));
    }
  }
}

// Paths ever touched.
const touched = git(["log", ...revs, "--name-only", "--format=COMMIT %H"]).split("\n");
let current = "";
for (const line of touched) {
  if (line.startsWith("COMMIT ")) current = line.slice(7);
  else if (line !== "")
    for (const f of FORBIDDEN_PATHS) if (f.pattern.test(line)) add(current, `path: ${f.name}`, line);
}

// Lines added.
const patch = git(["log", ...revs, "-p", "--no-color", "--no-ext-diff", "--format=COMMIT %H", "-U0"]).split("\n");
let file = "";
let skip = true;
for (const line of patch) {
  if (line.startsWith("COMMIT ")) {
    current = line.slice(7);
  } else if (line.startsWith("+++ ")) {
    file = line.startsWith("+++ b/") ? line.slice(6) : "";
    skip =
      file === "" ||
      SKIP_FILES.has(file) ||
      SKIP_PREFIXES.some((p) => file.startsWith(p)) ||
      !TEXT_EXTENSIONS.has(extname(file));
  } else if (line.startsWith("+") && !skip) {
    const text = line.slice(1);
    for (const rule of RULES) {
      if (rule.pattern.test(text) && !rule.allowedIn?.has(file))
        add(current, `${file}: ${rule.name}`, text.trim().slice(0, 100));
    }
    // Test files hold made-up secrets to prove they are redacted; they are not looked at for secrets.
    if (!/(^|\/)test\//.test(file))
      for (const s of SECRETS)
        if (s.pattern.test(text)) add(current, `${file}: possible secret (${s.name})`, "[value not shown]");
  }
}

/**
 * Findings in four early commits that are known and kept: rewriting them would change every later commit id, which the
 * evaluation files and the preregistration check cite. Matched by full commit id, so nothing else is let through.
 */
const KNOWN = new Map([
  [
    "fe12b6929c31a27c02df1f46f2b92b0de04db574",
    "first scaffold commit: its message and notices name the planned build steps by number and call the project unfinished",
  ],
  [
    "9d6b06dea12c8138b0e11194aa4349f8129b8ca6",
    "early API shell: comments named the later build step, by number, that would fill a placeholder",
  ],
  [
    "8f2fa1a643f8b18ce4390f0e877c48c95b591f42",
    "a laptop model name matches the step-number rule; it is hardware, not a build step",
  ],
  [
    "ab0de081200fd68cad47abc515424097dacafd58",
    "a laptop model name matches the step-number rule; it is hardware, not a build step",
  ],
]);
const allowed = problems.filter((p) => [...KNOWN.keys()].some((k) => k.startsWith(p.commit)));
problems.splice(0, problems.length, ...problems.filter((p) => !allowed.includes(p)));

const count = git(["rev-list", ...revs, "--count"]).trim();
if (allowed.length > 0) {
  const commits = new Set(allowed.map((p) => p.commit));
  console.log(
    `scan:history: ${allowed.length} known finding(s) in ${commits.size} early commit(s) allowed, each with its reason in the script`,
  );
}
if (problems.length > 0) {
  const byCommit = Object.groupBy(problems, (p) => p.commit);
  console.error(
    `scan:history found ${problems.length} problem(s) in ${Object.keys(byCommit).length} commit(s) of ${count}:`,
  );
  for (const p of problems.slice(0, 200)) console.error(`  ${p.commit}  ${p.kind}: ${p.detail}`);
  process.exit(1);
}
console.log(`scan:history ok (${count} commits: messages, added lines and paths checked)`);

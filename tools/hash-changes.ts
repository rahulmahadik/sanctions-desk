/**
 * Prove that the exported run files whose hash differs from their manifest (eval/runs/<run>/run-meta.json) changed in
 * one documented way only: the "commit" field of results.json, re-pointed to the rewritten commit when the history was
 * rewritten on 24 Oct 2026. The manifests keep their original hashes; eval/runs/HASH-CHANGES.json lists each change.
 *
 *   npm run evidence:hash-changes            # the proof: put each old value back and match the original hash
 *   npm run evidence:hash-changes -- --write # build HASH-CHANGES.json from the git history (done once; needs git)
 *
 * --write reads each file as it was before the commit that re-pointed the references (REPOINT_COMMIT), takes the old and new
 * "commit" values, and checks each pair against the commit map of the rewrite when one is given with --map <file>.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import {
  checkFile,
  HASH_CHANGES_FILE,
  type HashChange,
  type HashChanges,
  readHashChanges,
  sha256Hex,
} from "./lib/hash-changes.js";

const REPOINT_COMMIT = "20fcdde";
const runsDir = resolveProjectPath("eval/runs");
const runs = readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "run-meta.json")));
const manifestOf = (run: string) =>
  (
    JSON.parse(readFileSync(join(runsDir, run, "run-meta.json"), "utf8")) as {
      files?: Record<string, { sha256: string }>;
    }
  ).files ?? {};

if (process.argv.includes("--write")) {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  /** The one "commit" value in the file, wherever it sits; undefined if there is none or more than one. */
  const commitOf = (text: string): string | undefined => {
    const found: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (k === "commit" && typeof x === "string") found.push(x);
          else walk(x);
        }
    };
    walk(JSON.parse(text));
    return found.length === 1 ? found[0] : undefined;
  };
  // The commit map of the rewrite (old full id, new full id per line), when given with --map <file>.
  const mapArg = process.argv.indexOf("--map");
  const mapFile = mapArg > 0 ? process.argv[mapArg + 1] : undefined;
  const map = new Map<string, string>();
  if (mapFile && existsSync(mapFile))
    for (const l of readFileSync(mapFile, "utf8").split("\n")) {
      const [o, n] = l.trim().split(/\s+/);
      if (o && n && /^[0-9a-f]{40}$/.test(o)) map.set(o.slice(0, 7), n.slice(0, 7));
    }
  const changes: HashChange[] = [];
  for (const run of runs) {
    for (const [file, { sha256 }] of Object.entries(manifestOf(run))) {
      const path = join(runsDir, run, file);
      const now = readFileSync(path);
      if (sha256Hex(now) === sha256) continue;
      if (file !== "results.json") throw new Error(`${run}/${file} differs from its manifest and is not results.json`);
      const before = git(["show", `${REPOINT_COMMIT}^:eval/runs/${run}/${file}`]);
      if (sha256Hex(before) !== sha256)
        throw new Error(`${run}/${file}: the file before ${REPOINT_COMMIT} does not match its manifest`);
      const oldValue = commitOf(before);
      const newValue = commitOf(now.toString("utf8"));
      if (!oldValue || !newValue) throw new Error(`${run}/${file}: not exactly one commit field`);
      const oldShort = oldValue.slice(0, 7);
      const newShort = newValue.slice(0, 7);
      if (map.size > 0 && map.get(oldShort) !== newShort)
        throw new Error(`${run}/${file}: ${oldShort} -> ${newShort} is not in the commit map of the rewrite`);
      if (oldValue.slice(7) !== newValue.slice(7)) throw new Error(`${run}/${file}: the value changed beyond the id`);
      changes.push({
        run,
        file,
        original_sha256: sha256,
        current_sha256: sha256Hex(now),
        field: "commit",
        original_value: oldValue,
        current_value: newValue,
      });
    }
  }
  const doc: HashChanges = {
    reason: `When the repository history was rewritten on 24 Oct 2026, the "commit" field of each results.json was re-pointed from the old commit id to the rewritten one (commit ${REPOINT_COMMIT}, "Point every commit reference at the rewritten history"), following the rewrite's commit map. Nothing else in these files changed. The manifests (run-meta.json) keep the hashes recorded at export; npm run evidence:hash-changes puts each old value back and checks that the file then matches its original hash.${map.size > 0 ? " Each old -> new pair was checked against the commit map of the rewrite when this file was written." : ""}`,
    changes,
  };
  writeFileSync(join(runsDir, HASH_CHANGES_FILE), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${HASH_CHANGES_FILE}: ${changes.length} documented changes`);
}

// The proof, which needs no git: every file of every run either matches its manifest or is a documented change.
const doc = readHashChanges(runsDir);
let remapped = 0;
let other = 0;
const used = new Set<string>();
for (const run of runs) {
  for (const [file, { sha256 }] of Object.entries(manifestOf(run))) {
    const change = doc?.changes.find((c) => c.run === run && c.file === file);
    const result = checkFile(readFileSync(join(runsDir, run, file)), sha256, change);
    if (result === "remapped") {
      remapped += 1;
      used.add(`${run}/${file}`);
    }
    if (result === "differs") {
      other += 1;
      console.error(`${run}/${file}: differs from its manifest in a way that is not documented`);
    }
  }
}
const unused = (doc?.changes ?? []).filter((c) => !used.has(`${c.run}/${c.file}`));
for (const c of unused)
  console.error(`${c.run}/${c.file}: documented as changed, but it no longer differs in that way`);
console.log(
  `${remapped} files verified, commit field remapped (documented); ${other} other differences; ${unused.length} stale entries`,
);
process.exit(other === 0 && unused.length === 0 ? 0 : 1);

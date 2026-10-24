/**
 * Documented changes to exported run files after export (eval/runs/HASH-CHANGES.json). Each entry names the file, the
 * hash the run's manifest (run-meta.json) recorded at export, the file's hash now, and the one field that changed with
 * its value then and now. A file passes only when its hash now is the documented one AND putting the old value back
 * (the same line, nothing else) gives exactly the manifest's hash. Any other difference fails.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HashChange {
  run: string;
  file: string;
  original_sha256: string;
  current_sha256: string;
  field: "commit";
  original_value: string;
  current_value: string;
}

export interface HashChanges {
  reason: string;
  changes: HashChange[];
}

export const HASH_CHANGES_FILE = "HASH-CHANGES.json";

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The field as the exporter writes it in the JSON text (whatever its indent). */
export const fieldLine = (field: string, value: string): string => `"${field}": ${JSON.stringify(value)}`;

export function readHashChanges(runsDir: string): HashChanges | undefined {
  const file = join(runsDir, HASH_CHANGES_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as HashChanges) : undefined;
}

export type FileCheck = "match" | "remapped" | "differs";

/**
 * Check one file of a run against its manifest hash. "remapped" means the only change is the documented one: the
 * current text hashes to the documented hash, holds the documented field line exactly once, and with the old value put
 * back hashes to the manifest's original hash.
 */
export function checkFile(data: Buffer, manifestSha: string, change: HashChange | undefined): FileCheck {
  const now = sha256Hex(data);
  if (now === manifestSha) return "match";
  if (!change || change.original_sha256 !== manifestSha || change.current_sha256 !== now) return "differs";
  const text = data.toString("utf8");
  const current = fieldLine(change.field, change.current_value);
  if (text.split(current).length !== 2) return "differs";
  const restored = text.replace(current, fieldLine(change.field, change.original_value));
  return sha256Hex(restored) === manifestSha ? "remapped" : "differs";
}

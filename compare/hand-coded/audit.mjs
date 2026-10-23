// Audit: which identity ran which read, on which table, how many rows, when.
import { appendFileSync, mkdirSync } from "node:fs";

export function createAudit(dir) {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/audit.jsonl`;
  return {
    file,
    record(entry) {
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    },
  };
}

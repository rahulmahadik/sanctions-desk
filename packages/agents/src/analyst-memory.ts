import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Row } from "./types.js";

/**
 * Decisions that people made on the desk's own recommendations, kept so that later reviews of the same customer and
 * listed party can recall them. A row holds the outcome, the reason code and a pointer (the listed entry's id and
 * content hash when it was decided), never a copy of the customer's data. The memory step turns each row into a
 * pointer memory and checks the pointer against the entry as it is now.
 */

const analystMemoryFile = (logDir: string): string => join(logDir, "decisions", "memory.jsonl");

export function appendAnalystMemory(logDir: string, row: Row): void {
  const file = analystMemoryFile(logDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o640 });
}

/** The recorded decisions for one customer and listed entry, oldest first. */
export function readAnalystMemory(logDir: string, customerId: string, entryId: string): Row[] {
  const file = analystMemoryFile(logDir);
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Row;
      if (row.customer_id === customerId && row.entry_id === entryId) rows.push(row);
    } catch {
      // a half-written line is not a decision
    }
  }
  return rows.sort((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? ""));
}

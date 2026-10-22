// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Append-only trust ledger. Entries are never changed or removed; history() rebuilds a memory's
// change record from the previous and new state carried on each entry.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerAction, LedgerEntry, MemoryRecord } from "./types.js";

export class TrustLedgerService {
  private entries: LedgerEntry[] = [];
  private readonly file?: string;

  constructor(
    private readonly clock: () => number,
    persistDir?: string,
  ) {
    if (persistDir) {
      this.file = join(persistDir, "ledger.jsonl");
      if (existsSync(this.file)) {
        this.entries = readFileSync(this.file, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LedgerEntry);
      }
    }
  }

  log(
    memoryId: string,
    action: LedgerAction,
    actor: string,
    extra?: {
      previousState?: Partial<MemoryRecord>;
      newState?: Partial<MemoryRecord>;
      details?: Record<string, unknown>;
    },
  ): LedgerEntry {
    const entry: LedgerEntry = { memoryId, action, actor, timestamp: this.clock(), ...extra };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf-8");
    return entry;
  }

  history(memoryId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.memoryId === memoryId);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) out[e.action] = (out[e.action] ?? 0) + 1;
    return out;
  }
}

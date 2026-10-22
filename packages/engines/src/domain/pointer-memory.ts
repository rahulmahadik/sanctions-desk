import {
  type CurrentRow,
  checkPointer,
  type DispositionMemory,
  DispositionMemorySchema,
  type MemoryPointer,
  memoryUsable,
  type PointerState,
} from "@sanctions-desk/shared";
import { HMEM, type LedgerEntry, type MemoryRecord } from "../hmem/index.js";

/**
 * Pointer memory: past decisions kept in H-MEM without keeping personal data.
 *
 * What H-MEM stores is the outcome and the reason codes, plus tags that say where to look (the USL table
 * and the row key). The pointers themselves (table, key, content hash, list snapshot) are kept beside the
 * record. Before a memory may influence a new decision, every pointer is re-checked against the row as it
 * is now: a changed hash means the memory is stale and the case must be looked at again.
 *
 * A human override always beats memory. It marks the memory as superseded, so it can no longer influence
 * a decision, and it is written to the trust ledger with who did it and why.
 */

/** Reads the current state of a pointed-to row. `undefined` means the row no longer exists. */
export type RowLookup = (pointer: MemoryPointer) => Promise<CurrentRow | undefined> | CurrentRow | undefined;

export interface PointerMemoryOptions {
  lookup: RowLookup;
  hmem?: HMEM;
  clock?: () => number;
}

export interface RecalledMemory {
  memory: DispositionMemory;
  record: MemoryRecord;
  pointerStates: PointerState[];
  /** True only when every pointer is fresh and no person has overridden the memory. */
  usable: boolean;
  /** True when a pointer is stale or missing: the earlier decision should be re-opened for review. */
  reopen: boolean;
  overridden: boolean;
}

export interface OverrideInput {
  memoryId: string;
  actor: string;
  reason: string;
}

const keyTag = (table: string, key: Record<string, string>): string =>
  `key:${table}:${Object.entries(key)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}`;

export class PointerMemory {
  readonly hmem: HMEM;
  private readonly lookup: RowLookup;
  private readonly bodies = new Map<string, DispositionMemory>();
  private readonly overrides = new Map<string, OverrideInput>();

  constructor(options: PointerMemoryOptions) {
    this.lookup = options.lookup;
    this.hmem = options.hmem ?? new HMEM({ clock: options.clock, actor: "pointer-memory" });
  }

  /** Remember a decision. The input is validated; the H-MEM record holds codes and tags, never row contents. */
  remember(input: DispositionMemory): MemoryRecord {
    const memory = DispositionMemorySchema.parse(input);
    if (this.bodies.has(memory.memory_id)) throw new Error(`pointer memory: ${memory.memory_id} already exists`);
    const tags = memory.pointers.map((p) => keyTag(p.usl_table, p.row_key));
    const record = this.hmem.add({
      content: `Past ${memory.alert_type} decision ${memory.decision}: ${memory.reason_codes.join(", ")}`,
      type: "factual",
      layer: "long_term",
      tags: [`decision:${memory.decision}`, ...tags],
      source: `decision-record:${memory.decision_record_hash}`,
      confidence: 0.9,
      provenance: {
        origin: "manual",
        learnedAt: Date.parse(memory.created_at),
        label: `disposition memory ${memory.memory_id}`,
        refs: [memory.decision_record_hash],
      },
    });
    this.bodies.set(record.id, { ...memory, memory_id: record.id });
    return record;
  }

  /** Memories that point at the given row, each with its pointers re-checked against the current rows. */
  async recall(table: string, rowKey: Record<string, string>): Promise<RecalledMemory[]> {
    const wanted = keyTag(table, rowKey);
    const out: RecalledMemory[] = [];
    for (const [id, memory] of this.bodies) {
      const record = this.hmem.store.get(id);
      if (!record?.tags.includes(wanted)) continue;
      out.push(await this.check(id, memory, record));
    }
    return out;
  }

  private async check(id: string, memory: DispositionMemory, record: MemoryRecord): Promise<RecalledMemory> {
    const pointerStates: PointerState[] = [];
    for (const pointer of memory.pointers) {
      pointerStates.push(checkPointer(pointer, await this.lookup(pointer)));
    }
    const overridden = this.overrides.has(id);
    const reopen = pointerStates.some((s) => s !== "fresh");
    if (reopen && !record.tags.includes("stale")) this.hmem.store.update(id, { tags: [...record.tags, "stale"] });
    return {
      memory,
      record,
      pointerStates,
      usable: memoryUsable(pointerStates) && !overridden && !memory.superseded_by,
      reopen,
      overridden,
    };
  }

  /** A person overrides a memory. It stops influencing decisions and the ledger records who and why. */
  override(input: OverrideInput): LedgerEntry {
    const record = this.hmem.store.get(input.memoryId);
    if (!record || !this.bodies.has(input.memoryId)) {
      throw new Error(`pointer memory: unknown memory ${input.memoryId}`);
    }
    if (input.reason.trim() === "") throw new Error("pointer memory: an override needs a reason");
    this.overrides.set(input.memoryId, input);
    this.hmem.store.update(input.memoryId, { supersededBy: `override:${input.actor}` });
    return this.hmem.ledger.log(input.memoryId, "conflict_resolved", input.actor, {
      details: { winner: "human_override", actor: input.actor, reason: input.reason },
    });
  }

  /** Everything the ledger knows about a memory, oldest first. */
  history(memoryId: string): LedgerEntry[] {
    return this.hmem.ledger.history(memoryId);
  }

  size(): number {
    return this.bodies.size;
  }
}

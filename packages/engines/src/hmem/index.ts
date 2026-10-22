// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// H-MEM facade: deterministic, no runtime dependencies, in memory with optional JSON persistence.

import { ConflictDetectionService } from "./conflict-detection.js";
import { DreamingService } from "./dreaming.js";
import { MemoryMiningService } from "./memory-mining.js";
import { MemoryRetrievalService } from "./memory-retrieval.js";
import { type AddInput, MemoryStoreService } from "./memory-store.js";
import { SleepCycleService } from "./sleep-cycle.js";
import { TrustLedgerService } from "./trust-ledger.js";
import type { FeedbackKind, HMEMOptions, MemoryRecord, MiningEventType, QueryResult } from "./types.js";

export { ConflictDetectionService } from "./conflict-detection.js";
export { DreamingService } from "./dreaming.js";
export { cosine, embed, jaccard, tokenize } from "./embeddings.js";
export { MemoryMiningService, parseStrictJsonArray } from "./memory-mining.js";
export { MemoryRetrievalService } from "./memory-retrieval.js";
export { type AddInput, MemoryStoreService } from "./memory-store.js";
export { SleepCycleService } from "./sleep-cycle.js";
export { TrustLedgerService } from "./trust-ledger.js";
export * from "./types.js";

export class HMEM {
  readonly ledger: TrustLedgerService;
  readonly store: MemoryStoreService;
  readonly mining: MemoryMiningService;
  readonly retrieval: MemoryRetrievalService;
  readonly conflicts: ConflictDetectionService;
  readonly sleep: SleepCycleService;
  readonly dreaming: DreamingService;
  readonly clock: () => number;

  constructor(opts: HMEMOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    const actor = opts.actor ?? "system";
    this.ledger = new TrustLedgerService(this.clock, opts.persistDir);
    this.store = new MemoryStoreService(this.clock, this.ledger, actor, opts.persistDir);
    this.mining = new MemoryMiningService(this.store, this.clock, opts.minerFn);
    this.retrieval = new MemoryRetrievalService(this.store, this.ledger, this.clock, actor);
    this.conflicts = new ConflictDetectionService(this.store, this.ledger, this.clock, actor);
    this.sleep = new SleepCycleService(this.store, this.ledger, this.clock, actor);
    this.dreaming = new DreamingService(this.store, this.ledger, this.clock, actor);
  }

  add(input: AddInput): MemoryRecord {
    return this.store.add(input);
  }

  mine(event: MiningEventType, text: string, opts?: { chatId?: string }): Promise<MemoryRecord[]> {
    return this.mining.mineInteraction(event, text, opts);
  }

  query(query: string, opts?: { topN?: number; threshold?: number; chatId?: string }): QueryResult {
    return this.retrieval.query(query, opts);
  }

  feedback(memoryId: string, kind: FeedbackKind): void {
    this.retrieval.feedback(memoryId, kind);
  }
}

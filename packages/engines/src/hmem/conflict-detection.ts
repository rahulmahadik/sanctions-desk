// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Conflict detection and resolution. The losing record is marked supersededBy (kept, penalised in
// ranking), never deleted. A conflict is resolved automatically only at a decision confidence of 0.70
// or more; everything else queues for a person.

import { cosine } from "./embeddings.js";
import type { MemoryStoreService } from "./memory-store.js";
import { snapshot } from "./memory-store.js";
import type { TrustLedgerService } from "./trust-ledger.js";
import type { ConflictRecord, MemoryRecord } from "./types.js";
import { clamp01, DEFAULTS } from "./types.js";

const OPPOSING_PAIRS: Array<[RegExp, RegExp]> = [
  [/\balways\b/i, /\bnever\b/i],
  [/\benable[ds]?\b/i, /\bdisable[ds]?\b/i],
  [/\bprefer[s]?\b/i, /\bavoid[s]?|dislike[s]?\b/i],
  [/\bon\b/i, /\boff\b/i],
  [/\byes\b/i, /\bno\b/i],
];

export class ConflictDetectionService {
  private conflicts: ConflictRecord[] = [];
  private seq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly actor: string,
  ) {}

  scan(): ConflictRecord[] {
    const found: ConflictRecord[] = [];
    const all = this.store.all();
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        const conflict = a && b ? this.check(a, b) : undefined;
        if (!conflict) continue;
        found.push(conflict);
        this.conflicts.push(conflict);
        this.ledger.log(conflict.memoryA, "conflict_detected", this.actor, {
          details: { with: conflict.memoryB, reason: conflict.reason, confidence: conflict.confidence },
        });
      }
    }
    return found;
  }

  private check(a: MemoryRecord, b: MemoryRecord): ConflictRecord | undefined {
    // A supersedes relation is an intended replacement, not a conflict.
    if (a.supersedes === b.id || b.supersedes === a.id || a.supersededBy === b.id || b.supersededBy === a.id) {
      return undefined;
    }
    const sim = cosine(a.embedding, b.embedding);
    const found = opposingPhrases(a, b, sim) ?? conflictingNumbers(a, b, sim);
    if (!found) return undefined;

    let confidence = found.confidence;
    if (a.entities.some((e) => b.entities.includes(e))) confidence += 0.1;
    if (a.domain === b.domain) confidence += 0.05;
    if (a.relatedTo.includes(b.id)) confidence -= 0.1;

    this.seq += 1;
    return {
      id: `conflict-${this.seq}`,
      memoryA: a.id,
      memoryB: b.id,
      reason: found.reason,
      confidence: clamp01(confidence),
      resolved: false,
    };
  }

  /** Weighted auto-decision heuristics. */
  autoResolve(conflict: ConflictRecord): "resolved" | "queued" {
    const a = this.store.get(conflict.memoryA);
    const b = this.store.get(conflict.memoryB);
    if (!a || !b) throw new Error("H-MEM: a conflicting record no longer exists");
    const sa = this.scoreOf(a);
    const sb = this.scoreOf(b);
    const margin = Math.abs(sa - sb) / Math.max(sa, sb);
    const decisionConfidence = clamp01(conflict.confidence * 0.6 + margin * 0.8);
    if (decisionConfidence < DEFAULTS.conflictAutoResolveGate) return "queued";

    const [winner, loser] = sa >= sb ? [a, b] : [b, a];
    const prev = snapshot(loser);
    loser.supersededBy = winner.id;
    conflict.resolved = true;
    conflict.resolution = winner.id === conflict.memoryA ? "keep_a" : "keep_b";
    this.ledger.log(loser.id, "conflict_resolved", this.actor, {
      previousState: prev,
      newState: snapshot(loser),
      details: {
        conflictId: conflict.id,
        winner: winner.id,
        decisionConfidence: Number(decisionConfidence.toFixed(3)),
      },
    });
    this.store.persist();
    return "resolved";
  }

  queue(): ConflictRecord[] {
    return this.conflicts.filter((c) => !c.resolved);
  }

  private scoreOf(m: MemoryRecord): number {
    return (
      0.3 * (m.lastAccessed / Math.max(1, this.clock())) +
      0.2 * Math.min(1, m.accessCount / 10) +
      0.25 * m.confidence +
      0.1 * Math.min(1, m.content.length / 200) +
      0.15 * (m.provenance.origin === "user_correction" ? 1 : 0.5)
    );
  }
}

interface Finding {
  reason: string;
  confidence: number;
}

function opposingPhrases(a: MemoryRecord, b: MemoryRecord, sim: number): Finding | undefined {
  if (sim <= 0.5) return undefined;
  for (const [p, q] of OPPOSING_PAIRS) {
    if ((p.test(a.content) && q.test(b.content)) || (q.test(a.content) && p.test(b.content))) {
      return { reason: "opposing phrase pair on similar content", confidence: 0.5 + 0.3 * sim };
    }
  }
  return undefined;
}

function conflictingNumbers(a: MemoryRecord, b: MemoryRecord, sim: number): Finding | undefined {
  if (sim <= 0.8) return undefined;
  const numsA = a.content.match(/\d+(\.\d+)?/g) ?? [];
  const numsB = b.content.match(/\d+(\.\d+)?/g) ?? [];
  if (numsA.length > 0 && numsB.length > 0 && numsA.join() !== numsB.join()) {
    return { reason: "high-similarity conflicting numeric values", confidence: 0.55 + 0.25 * sim };
  }
  return undefined;
}

// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Hybrid retrieval and reinjection. The canonical formula:
//
//   raw   = 0.35*semantic + 0.20*keyword + 0.10*tag + 0.10*domain
//         + 0.15*entity   + 0.05*layer   + 0.05*recency - 0.20*superseded
//   score = clamp01(raw) * confidence          (confidence multiplies after the sum)
//
// keyword is the Jaccard overlap of the top 8 query tokens with the memory tokens.
// Layer weights: long_term 1.0, working 0.8, short_term 0.6.
// Recency is exponential decay on lastAccessed with a 14-day time constant.
// Superseded records are penalised, never deleted or filtered.
// The 0.35 threshold applies to the final score; the default top N is 5.

import { cosine, embed, jaccard, tokenize } from "./embeddings.js";
import type { MemoryStoreService } from "./memory-store.js";
import { snapshot } from "./memory-store.js";
import type { TrustLedgerService } from "./trust-ledger.js";
import type { FeedbackKind, MemoryRecord, QueryResult, RetrievedMemory } from "./types.js";
import { clamp01, DAY_MS, DEFAULTS, FEEDBACK_DELTAS } from "./types.js";

const LAYER_WEIGHT: Record<MemoryRecord["layer"], number> = {
  long_term: 1.0,
  working: 0.8,
  short_term: 0.6,
};

interface QueryFeatures {
  embedding: number[];
  tokens: string[];
  entities: string[];
  domain: string;
}

export class MemoryRetrievalService {
  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly actor: string,
  ) {}

  private features(query: string): QueryFeatures {
    return {
      embedding: embed(query),
      tokens: tokenize(query).slice(0, 8),
      entities: this.store.extractEntities(query),
      domain: this.store.classifyDomain(query, [], "general"),
    };
  }

  scoreOne(memory: MemoryRecord, query: string): number {
    return this.score(memory, this.features(query));
  }

  private score(m: MemoryRecord, q: QueryFeatures): number {
    const semantic = clamp01(cosine(q.embedding, m.embedding));
    const keyword = jaccard(q.tokens, tokenize(m.content));
    const tag = jaccard(
      q.tokens,
      m.tags.map((t) => t.toLowerCase()),
    );
    const domain = m.domain === q.domain ? 1 : 0;
    const entity = jaccard(q.entities, m.entities);
    const layer = LAYER_WEIGHT[m.layer];
    const ageDays = (this.clock() - m.lastAccessed) / DAY_MS;
    const recency = Math.exp(-ageDays / DEFAULTS.recencyDays);
    const superseded = m.supersededBy ? 1 : 0;
    const raw =
      0.35 * semantic +
      0.2 * keyword +
      0.1 * tag +
      0.1 * domain +
      0.15 * entity +
      0.05 * layer +
      0.05 * recency -
      0.2 * superseded;
    return clamp01(raw) * m.confidence;
  }

  query(query: string, opts?: { topN?: number; threshold?: number; chatId?: string }): QueryResult {
    const q = this.features(query);
    const threshold = opts?.threshold ?? DEFAULTS.retrievalThreshold;
    const topN = opts?.topN ?? DEFAULTS.retrievalTopN;

    const scored: RetrievedMemory[] = [];
    for (const m of this.store.all()) {
      if (opts?.chatId && m.chatId && m.chatId !== opts.chatId) continue;
      const relevance = this.score(m, q);
      if (relevance >= threshold) scored.push({ memory: m, relevance });
    }
    scored.sort((a, b) => b.relevance - a.relevance || a.memory.id.localeCompare(b.memory.id));
    const top = scored.slice(0, topN);

    for (const { memory } of top) {
      this.store.touch(memory.id);
      this.ledger.log(memory.id, "read", this.actor, { details: { query } });
    }

    return {
      memories: top,
      context: this.formatReinjection(top),
      trace: {
        retrievalReason: `hybrid ranking for "${query}" (domain: ${q.domain})`,
        strategy: strategyOf(top),
        scores: Object.fromEntries(top.map((t) => [t.memory.id, Number(t.relevance.toFixed(4))])),
      },
    };
  }

  /** Domain-grouped reinjection blocks with layer markers and entities. */
  formatReinjection(items: RetrievedMemory[]): string {
    if (items.length === 0) return "";
    const byDomain = new Map<string, RetrievedMemory[]>();
    for (const it of items) {
      const list = byDomain.get(it.memory.domain) ?? [];
      list.push(it);
      byDomain.set(it.memory.domain, list);
    }
    const lines: string[] = ["[MEMORY CONTEXT]"];
    for (const [domain, list] of [...byDomain.entries()].sort()) {
      lines.push(`## ${domain}`, ...list.map(({ memory }) => reinjectionLine(memory)));
    }
    lines.push("[/MEMORY CONTEXT]");
    return lines.join("\n");
  }

  /** Exact feedback deltas: helpful +0.05 (and one access), not_helpful -0.03, wrong -0.20 (and a review tag). */
  feedback(memoryId: string, kind: FeedbackKind): void {
    const m = this.store.get(memoryId);
    if (!m) throw new Error(`H-MEM: unknown memory id ${memoryId}`);
    const prev = snapshot(m);
    if (kind === "helpful") m.accessCount += 1;
    m.confidence = clamp01(m.confidence + FEEDBACK_DELTAS[kind]);
    if (kind === "wrong" && !m.tags.includes("review")) m.tags.push("review");
    this.ledger.log(memoryId, "feedback", this.actor, {
      previousState: prev,
      newState: snapshot(m),
      details: { kind, delta: FEEDBACK_DELTAS[kind] },
    });
    this.store.persist();
  }
}

const LAYER_MARKER: Record<MemoryRecord["layer"], string> = { long_term: "LT", working: "WK", short_term: "ST" };

function reinjectionLine(memory: MemoryRecord): string {
  const entities = memory.entities.length > 0 ? ` (entities: ${memory.entities.join(", ")})` : "";
  return `- [${LAYER_MARKER[memory.layer]}] ${memory.content}${entities} <${memory.id}>`;
}

function strategyOf(top: RetrievedMemory[]): QueryResult["trace"]["strategy"] {
  if (top.length <= 1) return "minimal";
  return top.some((t) => t.memory.type === "personal" || t.memory.type === "preference") ? "personal" : "comprehensive";
}

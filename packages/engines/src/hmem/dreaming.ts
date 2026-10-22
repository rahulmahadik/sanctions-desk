// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Dreaming: constructive synthesis with a human approval boundary. A proposal is never turned into a
// memory automatically; only approve() does that, and the new memory carries its derivedFrom lineage.

import { cosine, jaccard } from "./embeddings.js";
import type { MemoryStoreService } from "./memory-store.js";
import type { TrustLedgerService } from "./trust-ledger.js";
import type { DreamProposal, MemoryRecord } from "./types.js";
import { DEFAULTS } from "./types.js";

type ProposalInput = Omit<DreamProposal, "id" | "status">;

export class DreamingService {
  private proposals = new Map<string, DreamProposal>();
  private seq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly actor: string,
  ) {}

  /** Content similarity, tag overlap, shared domain and entity overlap. */
  private relatedness(a: MemoryRecord, b: MemoryRecord): number {
    return (
      0.5 * Math.max(0, cosine(a.embedding, b.embedding)) +
      0.2 * jaccard(a.tags, b.tags) +
      0.1 * (a.domain === b.domain ? 1 : 0) +
      0.2 * jaccard(a.entities, b.entities)
    );
  }

  private cluster(): MemoryRecord[][] {
    const all = this.store.all();
    const used = new Set<string>();
    const clusters: MemoryRecord[][] = [];
    for (const seed of all) {
      if (used.has(seed.id)) continue;
      const group = this.groupAround(seed, all, used);
      if (group.length < DEFAULTS.dreamClusterMinSize) continue;
      for (const g of group) used.add(g.id);
      clusters.push(group);
    }
    return clusters;
  }

  private groupAround(seed: MemoryRecord, all: MemoryRecord[], used: Set<string>): MemoryRecord[] {
    const related = all.filter(
      (other) =>
        other.id !== seed.id && !used.has(other.id) && this.relatedness(seed, other) >= DEFAULTS.dreamRelatedness,
    );
    return [seed, ...related];
  }

  private propose(input: ProposalInput): DreamProposal {
    this.seq += 1;
    const proposal: DreamProposal = { ...input, id: `dream-${this.seq}`, status: "proposed" };
    this.proposals.set(proposal.id, proposal);
    this.ledger.log(proposal.id, "dream_proposed", this.actor, {
      details: { type: input.type, derivedFrom: input.derivedFrom },
    });
    return proposal;
  }

  dream(): DreamProposal[] {
    return [...this.insights(), ...this.domainSuggestions(), ...this.invariants()];
  }

  private insights(): DreamProposal[] {
    return this.cluster()
      .slice(0, DEFAULTS.maxDreamProposalsPerType)
      .map((cluster) => {
        const domains = [...new Set(cluster.map((m) => m.domain))].join("/");
        return this.propose({
          type: "insight",
          content: `Across ${cluster.length} related memories (${domains}): ${cluster.map((m) => m.content).join(" + ")}`,
          derivedFrom: cluster.map((m) => m.id),
        });
      });
  }

  private domainSuggestions(): DreamProposal[] {
    const created: DreamProposal[] = [];
    for (const m of this.store.all()) {
      if (created.length >= DEFAULTS.maxDreamProposalsPerType) break;
      if (m.domain !== "general") continue;
      const suggested = this.store.classifyDomain(m.content, m.tags, m.type);
      if (suggested === "general") continue;
      created.push(
        this.propose({
          type: "domain",
          content: `Reclassify "${m.content.slice(0, 60)}" as ${suggested}`,
          derivedFrom: [m.id],
          suggestedDomain: suggested,
        }),
      );
    }
    return created;
  }

  private invariants(): DreamProposal[] {
    const preferences = this.store
      .all()
      .filter((m) => m.type === "preference" || m.type === "personal" || m.tags.includes("event:user_correction"));
    const byDomain = new Map<string, MemoryRecord[]>();
    for (const p of preferences) {
      const list = byDomain.get(p.domain) ?? [];
      list.push(p);
      byDomain.set(p.domain, list);
    }
    const created: DreamProposal[] = [];
    for (const [domain, list] of byDomain) {
      if (created.length >= DEFAULTS.maxDreamProposalsPerType) break;
      if (list.length < 2) continue;
      created.push(
        this.propose({
          type: "invariant",
          content: `Stable pattern in ${domain}: ${list.map((m) => m.content).join("; ")}`,
          derivedFrom: list.map((m) => m.id),
        }),
      );
    }
    return created;
  }

  pending(): DreamProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === "proposed");
  }

  approve(proposalId: string): MemoryRecord | undefined {
    const p = this.pendingProposal(proposalId);
    p.status = "approved";
    this.ledger.log(proposalId, "dream_approved", this.actor, { details: { type: p.type } });

    if (p.type === "domain") {
      for (const id of p.derivedFrom) {
        if (this.store.get(id) && p.suggestedDomain) this.store.update(id, { domain: p.suggestedDomain });
      }
      return undefined;
    }
    // An insight becomes a long-term factual memory, an invariant a long-term preference. Both carry lineage.
    return this.store.add({
      content: p.content,
      type: p.type === "insight" ? "factual" : "preference",
      layer: "long_term",
      tags: [`dream:${p.type}`],
      confidence: 0.75,
      source: "dreaming",
      provenance: { origin: "dream", learnedAt: this.clock(), label: `approved ${p.type} proposal` },
      derivedFrom: p.derivedFrom,
    });
  }

  reject(proposalId: string): void {
    const p = this.pendingProposal(proposalId);
    p.status = "rejected";
    this.ledger.log(proposalId, "dream_rejected", this.actor, { details: { type: p.type } });
  }

  private pendingProposal(id: string): DreamProposal {
    const p = this.proposals.get(id);
    if (p?.status !== "proposed") throw new Error(`H-MEM: no pending proposal ${id}`);
    return p;
  }
}

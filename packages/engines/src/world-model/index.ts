// Derived from the Meterless World Model reference implementation, Apache-2.0.
// World Model facade: event sourced and deterministic. Every write goes through a FIFO queue per
// instance, so concurrent writes serialise.

import { rebuildAggregates, runIngestPipeline, worldStateShape } from "./ingest.js";
import { decide, nameSimilarity } from "./resolve.js";
import {
  canonicalJson,
  contextIdFromAttrs,
  entityIdFromName,
  externalId,
  factId,
  relationshipId,
} from "./stable-ids.js";
import { EventStore } from "./store.js";
import type {
  AuditEntry,
  Context,
  Entity,
  Fact,
  IngestObservation,
  IngestReport,
  MergeProposal,
  Provenance,
  Relationship,
  StoredProvenance,
  WorldEvent,
  WorldModelOptions,
} from "./types.js";
import { FactsView, GraphView, SnapshotView, TimelineView } from "./views.js";

export { worldStateShape } from "./ingest.js";
export { decide, jaccard, levenshtein, nameSimilarity, type ResolutionDecision } from "./resolve.js";
export { canonicalJson, entityIdFromName, externalId, normalizeName, sha256Hex } from "./stable-ids.js";
export * from "./types.js";
export { FactsView, GraphView, SnapshotView, TimelineView } from "./views.js";

type ExternalKey = { system: string; id: string };

interface UpsertEntityInput {
  type: string;
  externalKey?: ExternalKey;
  name?: string;
  attrs?: Record<string, unknown>;
  source: Provenance | undefined;
  state?: Entity["state"];
}

interface UpsertContextInput {
  type: string;
  externalKey?: ExternalKey;
  attrs?: Record<string, unknown>;
  parent?: string;
  source: Provenance | undefined;
}

interface RelateInput {
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  source: Provenance | undefined;
}

interface AssertFactInput {
  about: string;
  predicate: string;
  value: unknown;
  confidence?: number;
  context?: string;
  source: Provenance | undefined;
}

interface CustomView<S> {
  events: string[];
  initialState: S;
  reducer: (state: S, event: WorldEvent) => S;
}

export class WorldModel {
  private readonly store: EventStore;
  private readonly opts: WorldModelOptions;
  private readonly clock: () => Date;
  private writeLock: Promise<unknown> = Promise.resolve();
  private readonly customViews = new Map<string, CustomView<unknown>>();

  constructor(opts: WorldModelOptions) {
    if (!opts.namespace) throw new Error("WorldModel: namespace is required");
    this.opts = opts;
    this.clock = opts.clock ?? (() => new Date());
    this.store = new EventStore(opts.namespace, opts.storage ?? "memory", opts.directory);
    // Aggregates are derived, not stored: recompute them for the state that was just loaded.
    rebuildAggregates(this.store);
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn);
    this.writeLock = next.catch(() => undefined);
    return next;
  }

  private normalizeProvenance(source: Provenance | undefined): StoredProvenance {
    if (!source?.kind || source.at === undefined) {
      throw new Error("World Model: every write carries provenance (kind + at). No provenance, no write.");
    }
    return { ...source, at: source.at instanceof Date ? source.at.toISOString() : source.at };
  }

  upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    return this.enqueue(() => {
      const source = this.normalizeProvenance(input.source);
      const name = input.name ?? (input.attrs?.name as string | undefined);
      const id = input.externalKey
        ? externalId(input.type, input.externalKey.system, input.externalKey.id)
        : entityIdFromName(input.type, mustName(name));

      // Name-keyed entities go through resolution: near duplicates auto-merge or queue for review.
      if (!input.externalKey && name) {
        const merged = this.resolveAgainstExisting(id, name, input, source);
        if (merged) return merged;
      }
      return this.foldEntityUpsert(id, input, source, name);
    });
  }

  private resolveAgainstExisting(
    id: string,
    name: string,
    input: UpsertEntityInput,
    source: StoredProvenance,
  ): Entity | undefined {
    const autoMergeAt = this.opts.resolver?.autoMergeAt ?? 0.85;
    const reviewLower = this.opts.resolver?.reviewBand?.[0] ?? 0.82;
    for (const other of this.store.state.entities.values()) {
      if (other.type !== input.type || other.id === id || !other.name) continue;
      const similarity = nameSimilarity(name, other.name);
      const decision = decide(similarity, autoMergeAt, reviewLower);
      if (decision === "auto-merge") {
        this.store.append(
          "alias",
          {
            aliasId: id,
            primaryId: other.id,
            mergedAt: source.at,
            mergedBy: "resolver",
            reason: `similarity ${similarity.toFixed(3)}`,
          },
          source.at,
        );
        this.store.logAudit(
          "auto-merge",
          "resolver",
          `${name} -> ${other.name} (${similarity.toFixed(3)})`,
          undefined,
          undefined,
          source.at,
        );
        return this.foldEntityUpsert(other.id, input, source, name);
      }
      if (decision === "review") this.queueReview(id, name, other, similarity, source.at);
    }
    return undefined;
  }

  private queueReview(id: string, name: string, other: Entity, similarity: number, at: string): void {
    const exists = this.store.mergeQueue.some(
      (p) => (p.leftId === id && p.rightId === other.id) || (p.leftId === other.id && p.rightId === id),
    );
    if (exists || !other.name) return;
    const proposal: MergeProposal = {
      id: `merge_${this.store.mergeQueue.length + 1}`,
      leftId: id,
      rightId: other.id,
      leftName: name,
      rightName: other.name,
      similarity,
      reason: "name similarity in review band [0.82, 0.85)",
      status: "pending",
      proposedAt: at,
    };
    this.store.mergeQueue.push(proposal);
    this.store.logAudit(
      "merge-proposed",
      "resolver",
      `${name} ~ ${other.name} (${similarity.toFixed(3)}) queued`,
      undefined,
      undefined,
      at,
    );
  }

  private foldEntityUpsert(id: string, input: UpsertEntityInput, source: StoredProvenance, name?: string): Entity {
    const resolved = this.store.resolveAlias(id);
    const entity: Entity = {
      type: input.type,
      id: resolved,
      attrs: { ...(input.attrs ?? {}) },
      schemaVersion: 1,
      source,
      createdAt: source.at,
      updatedAt: source.at,
      name,
      aliases: name ? [name] : [],
      state: input.state ?? "active",
    };
    const event = this.store.append("upsertEntity", entity, source.at);
    this.store.logAudit(
      "upsertEntity",
      source.by ?? "system",
      `${resolved} (${input.type})`,
      event.id,
      source.runId,
      source.at,
    );
    return this.mustEntity(resolved);
  }

  private mustEntity(id: string): Entity {
    const entity = this.store.state.entities.get(id);
    if (!entity) throw new Error(`World Model: entity ${id} was not stored`);
    return entity;
  }

  upsertContext(input: UpsertContextInput): Promise<Context> {
    return this.enqueue(() => {
      const source = this.normalizeProvenance(input.source);
      const id = input.externalKey
        ? externalId(input.type, input.externalKey.system, input.externalKey.id)
        : contextIdFromAttrs(input.type, input.attrs ?? {}, input.parent);
      const context: Context = {
        type: input.type,
        id,
        attrs: { ...(input.attrs ?? {}) },
        parent: input.parent,
        schemaVersion: 1,
        source,
        createdAt: source.at,
        updatedAt: source.at,
      };
      const event = this.store.append("upsertContext", context, source.at);
      this.store.logAudit(
        "upsertContext",
        source.by ?? "system",
        `${id} (${input.type})`,
        event.id,
        source.runId,
        source.at,
      );
      const stored = this.store.state.contexts.get(id);
      if (!stored) throw new Error(`World Model: context ${id} was not stored`);
      return stored;
    });
  }

  relate(input: RelateInput): Promise<Relationship> {
    return this.enqueue(() => {
      const source = this.normalizeProvenance(input.source);
      const from = this.store.resolveAlias(input.from);
      const to = this.store.resolveAlias(input.to);
      const id = relationshipId(from, input.type, to, input.context, input.validFrom);
      const existing = this.store.state.relationships.get(id);
      if (existing) return existing; // content-addressed no-op
      const rel: Relationship = {
        id,
        from,
        type: input.type,
        to,
        context: input.context,
        attrs: input.attrs,
        validFrom: input.validFrom ?? source.at,
        validTo: input.validTo,
        schemaVersion: 1,
        source,
        createdAt: source.at,
      };
      const event = this.store.append("relate", rel, source.at);
      this.store.logAudit(
        "relate",
        source.by ?? "system",
        `${from} -[${input.type}]-> ${to}`,
        event.id,
        source.runId,
        source.at,
      );
      const stored = this.store.state.relationships.get(id);
      if (!stored) throw new Error(`World Model: relationship ${id} was not stored`);
      return stored;
    });
  }

  assertFact(input: AssertFactInput): Promise<Fact> {
    return this.enqueue(() => {
      const source = this.normalizeProvenance(input.source);
      const about = this.store.resolveAlias(input.about);
      const id = factId(about, input.predicate, input.value, source.at, source.kind, source.url);
      const existing = this.store.state.facts.get(id);
      if (existing) return existing;

      const fact: Fact = {
        id,
        about,
        predicate: input.predicate,
        value: input.value,
        confidence: input.confidence ?? 0.5,
        context: input.context,
        source,
        assertedAt: source.at,
      };
      const policy = this.opts.conflictPolicy ?? "most-recent-wins";
      const rivals = [...this.store.state.facts.values()].filter(
        (f) => f.about === about && f.predicate === input.predicate && !f.supersededBy,
      );
      const winner = this.pickWinner(fact, rivals);
      const event = this.store.append("assertFact", fact, source.at);
      for (const f of [fact, ...rivals]) {
        const stored = this.store.state.facts.get(f.id);
        if (stored && f.id !== winner.id) stored.supersededBy = winner.id;
      }
      this.ensureSubject(about, source);
      const entity = this.mustEntity(about);
      entity.attrs[input.predicate] = winner.value;
      entity.updatedAt = source.at;

      this.store.logAudit(
        "assertFact",
        source.by ?? "system",
        `${about}.${input.predicate} = ${JSON.stringify(winner.value)} (${policy})`,
        event.id,
        source.runId,
        source.at,
      );
      this.store.persist();
      const stored = this.store.state.facts.get(id);
      if (!stored) throw new Error(`World Model: fact ${id} was not stored`);
      return stored;
    });
  }

  /** The conflict policy decides whose value lands on the entity. */
  private pickWinner(fact: Fact, rivals: Fact[]): Fact {
    const policy = this.opts.conflictPolicy ?? "most-recent-wins";
    let winner = fact;
    for (const rival of rivals) {
      const rivalWins =
        policy === "highest-confidence-wins"
          ? rival.confidence > winner.confidence
          : policy === "source-priority"
            ? priorityOf(rival.source.kind, this.opts.sourcePriority) <
              priorityOf(winner.source.kind, this.opts.sourcePriority)
            : rival.assertedAt > winner.assertedAt;
      if (rivalWins) winner = rival;
    }
    return winner;
  }

  private ensureSubject(about: string, source: StoredProvenance): void {
    if (this.store.state.entities.has(about)) return;
    const inferredType = about.includes(":") ? (about.split(":")[0] ?? "entity") : "entity";
    const entity: Entity = {
      type: inferredType,
      id: about,
      attrs: {},
      schemaVersion: 1,
      source,
      createdAt: source.at,
      updatedAt: source.at,
      aliases: [],
      state: "emerging",
    };
    this.store.append("upsertEntity", entity, source.at);
  }

  ingest(observations: IngestObservation[]): Promise<IngestReport> {
    return this.enqueue(() =>
      runIngestPipeline(
        this.store,
        observations,
        (obs) => this.ingestOne(obs),
        () => this.clock().getTime(),
      ),
    );
  }

  private ingestOne(obs: IngestObservation): { entityId: string; entityIds: string[] } {
    const source = this.normalizeProvenance({ ...obs.source, at: obs.at });
    const type = obs.type ?? "item";
    const entity = this.foldEntityUpsert(
      externalId(type, "ingest", obs.externalId),
      {
        type,
        externalKey: { system: "ingest", id: obs.externalId },
        attrs: { title: obs.title, text: obs.text },
        source,
      },
      source,
      obs.title,
    );
    const entityIds: string[] = [];
    for (const mention of obs.entities ?? []) {
      const mid = entityIdFromName(mention.type, mention.name);
      this.foldEntityUpsert(mid, { type: mention.type, name: mention.name, source }, source, mention.name);
      const target = this.store.resolveAlias(mid);
      entityIds.push(target);
      const rid = relationshipId(entity.id, "mentions", target);
      if (!this.store.state.relationships.has(rid)) {
        const rel: Relationship = {
          id: rid,
          from: entity.id,
          type: "mentions",
          to: target,
          validFrom: source.at,
          schemaVersion: 1,
          source,
          createdAt: source.at,
        };
        this.store.append("relate", rel, source.at);
      }
    }
    return { entityId: entity.id, entityIds: entityIds.sort() };
  }

  view(name: "graph"): GraphView;
  view(name: "facts"): FactsView;
  view(name: "snapshot"): SnapshotView;
  view(name: "timeline"): TimelineView;
  view(name: string): { get(): unknown };
  view(name: string): unknown {
    if (name === "graph") return new GraphView(this.store);
    if (name === "facts") return new FactsView(this.store);
    if (name === "snapshot") return new SnapshotView(this.store);
    if (name === "timeline") return new TimelineView(this.store);
    const custom = this.customViews.get(name);
    if (!custom) throw new Error(`World Model: unknown view "${name}"`);
    return {
      get: () => {
        let state = structuredClone(custom.initialState);
        for (const e of this.store.events) if (custom.events.includes(e.kind)) state = custom.reducer(state, e);
        return state;
      },
    };
  }

  registerView<S>(name: string, spec: CustomView<S>): void {
    this.customViews.set(name, spec as CustomView<unknown>);
  }

  mergeQueue(): readonly MergeProposal[] {
    return this.store.mergeQueue;
  }

  approveMerge(proposalId: string, by: string): Promise<void> {
    return this.enqueue(() => {
      const p = this.pendingProposal(proposalId);
      const at = this.clock().toISOString();
      p.status = "approved";
      p.resolvedAt = at;
      p.resolvedBy = by;
      this.store.append(
        "alias",
        { aliasId: p.leftId, primaryId: p.rightId, mergedAt: at, mergedBy: by, reason: p.reason },
        at,
      );
      this.store.logAudit("merge-approved", by, `${p.leftName} -> ${p.rightName}`, undefined, undefined, at);
    });
  }

  rejectMerge(proposalId: string, by: string): Promise<void> {
    return this.enqueue(() => {
      const p = this.pendingProposal(proposalId);
      p.status = "rejected";
      p.resolvedAt = this.clock().toISOString();
      p.resolvedBy = by;
      this.store.logAudit("merge-rejected", by, `${p.leftName} stays separate from ${p.rightName}`);
      this.store.persist();
    });
  }

  private pendingProposal(id: string): MergeProposal {
    const p = this.store.mergeQueue.find((m) => m.id === id && m.status === "pending");
    if (!p) throw new Error(`World Model: no pending merge proposal ${id}`);
    return p;
  }

  audit(): readonly AuditEntry[] {
    return this.store.audit;
  }

  events(): readonly WorldEvent[] {
    return this.store.events;
  }

  stateShape(): unknown {
    return worldStateShape(this.store);
  }

  stateShapeCanonical(): string {
    return canonicalJson(worldStateShape(this.store));
  }

  subscribeEvents(fn: (e: WorldEvent) => void): () => void {
    return this.store.subscribe(fn);
  }
}

function priorityOf(kind: string, ranking?: string[]): number {
  const idx = (ranking ?? []).indexOf(kind);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function mustName(name: string | undefined): string {
  if (!name) throw new Error("World Model: name-keyed entities need a name (or provide an externalKey)");
  return name;
}

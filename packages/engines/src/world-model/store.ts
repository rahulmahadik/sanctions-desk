// Derived from the Meterless World Model reference implementation, Apache-2.0.
// Event-sourced canonical store. State is a fold over an append-only event log and views are
// projections of the fold. Persistence is one JSON file per namespace (.world/<namespace>.json) replayed
// on load. Every mutation writes an audit entry.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Alias,
  AuditEntry,
  Context,
  Entity,
  EventKind,
  Fact,
  MergeProposal,
  ObservationRecord,
  Relationship,
  ScoreSnapshot,
  StoryAggregate,
  WorldEvent,
} from "./types.js";

export interface FoldedState {
  entities: Map<string, Entity>;
  contexts: Map<string, Context>;
  relationships: Map<string, Relationship>;
  facts: Map<string, Fact>;
  /** aliasId -> primaryId */
  aliases: Map<string, string>;
}

interface SavedStore {
  events: WorldEvent[];
  audit: AuditEntry[];
  observations: [string, ObservationRecord][];
  stories: [string, StoryAggregate][];
  scores: ScoreSnapshot[];
  mergeQueue: MergeProposal[];
}

const emptyState = (): FoldedState => ({
  entities: new Map(),
  contexts: new Map(),
  relationships: new Map(),
  facts: new Map(),
  aliases: new Map(),
});

export class EventStore {
  events: WorldEvent[] = [];
  audit: AuditEntry[] = [];
  observations = new Map<string, ObservationRecord>();
  stories = new Map<string, StoryAggregate>();
  scores: ScoreSnapshot[] = [];
  mergeQueue: MergeProposal[] = [];
  state: FoldedState = emptyState();
  private seq = 0;
  private auditSeq = 0;
  private readonly file?: string;
  private readonly subscribers = new Set<(e: WorldEvent) => void>();

  constructor(namespace: string, storage: "memory" | "local", directory?: string) {
    if (storage !== "local") return;
    const dir = join(directory ?? process.cwd(), ".world");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${namespace}.json`);
    if (existsSync(this.file)) this.load(JSON.parse(readFileSync(this.file, "utf-8")) as Partial<SavedStore>);
  }

  private load(saved: Partial<SavedStore>): void {
    this.audit = saved.audit ?? [];
    this.auditSeq = this.audit.at(-1)?.seq ?? 0;
    this.observations = new Map(saved.observations ?? []);
    this.stories = new Map(saved.stories ?? []);
    this.scores = saved.scores ?? [];
    this.mergeQueue = saved.mergeQueue ?? [];
    for (const e of saved.events ?? []) {
      this.seq = Math.max(this.seq, e.seq);
      this.events.push(e);
      this.fold(e);
    }
  }

  append(kind: EventKind, payload: WorldEvent["payload"], at: string): WorldEvent {
    const event: WorldEvent = { id: `evt_${this.seq + 1}`, seq: this.seq + 1, kind, payload, schemaVersion: 1, at };
    this.seq = event.seq;
    this.events.push(event);
    this.fold(event);
    this.persist();
    for (const fn of this.subscribers) fn(event);
    return event;
  }

  fold(event: WorldEvent): void {
    switch (event.kind) {
      case "upsertEntity":
        this.foldEntity(event.payload as Entity);
        break;
      case "upsertContext":
        this.foldContext(event.payload as Context);
        break;
      case "relate":
        this.foldRelationship(event.payload as Relationship);
        break;
      case "assertFact": {
        const f = event.payload as Fact;
        if (!this.state.facts.has(f.id)) this.state.facts.set(f.id, structuredClone(f));
        break;
      }
      case "alias": {
        const a = event.payload as Alias;
        this.state.aliases.set(a.aliasId, a.primaryId);
        break;
      }
      default:
        break;
    }
  }

  private foldEntity(e: Entity): void {
    const existing = this.state.entities.get(e.id);
    if (!existing) {
      this.state.entities.set(e.id, structuredClone(e));
      return;
    }
    existing.attrs = { ...existing.attrs, ...e.attrs };
    existing.updatedAt = e.updatedAt;
    existing.source = e.source;
    if (e.name && !existing.aliases.includes(e.name)) existing.aliases.push(e.name);
    if (e.name) existing.name = e.name;
  }

  private foldContext(c: Context): void {
    const existing = this.state.contexts.get(c.id);
    if (!existing) {
      this.state.contexts.set(c.id, structuredClone(c));
      return;
    }
    existing.attrs = { ...existing.attrs, ...c.attrs };
    existing.updatedAt = c.updatedAt;
  }

  /** A new open edge with the same (from, type, context) but another target closes the previous open edge. */
  private foldRelationship(r: Relationship): void {
    for (const other of this.state.relationships.values()) {
      const sameSlot = other.from === r.from && other.type === r.type && (other.context ?? "") === (r.context ?? "");
      if (sameSlot && other.to !== r.to && !other.validTo && !other.supersededBy) {
        other.validTo = r.validFrom ?? r.createdAt;
        other.supersededBy = r.id;
      }
    }
    if (!this.state.relationships.has(r.id)) this.state.relationships.set(r.id, structuredClone(r));
  }

  /** The state as of a timestamp: replay the events with at <= timestamp. */
  foldUntil(at: string): FoldedState {
    const scratch = new EventStore("scratch", "memory");
    for (const e of this.events) if (e.at <= at) scratch.fold(e);
    return scratch.state;
  }

  resolveAlias(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    for (
      let next = this.state.aliases.get(cur);
      next !== undefined && !seen.has(cur);
      next = this.state.aliases.get(cur)
    ) {
      seen.add(cur);
      cur = next;
    }
    return cur;
  }

  logAudit(kind: string, actor: string, summary: string, eventId?: string, runId?: string, at?: string): void {
    this.auditSeq += 1;
    this.audit.push({ seq: this.auditSeq, at: at ?? new Date(0).toISOString(), kind, actor, summary, eventId, runId });
    this.persist();
  }

  subscribe(fn: (e: WorldEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  persist(): void {
    if (!this.file) return;
    const data: SavedStore = {
      events: this.events,
      audit: this.audit,
      observations: [...this.observations.entries()],
      stories: [...this.stories.entries()],
      scores: this.scores,
      mergeQueue: this.mergeQueue,
    };
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }
}

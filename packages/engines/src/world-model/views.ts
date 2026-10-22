// Derived from the Meterless World Model reference implementation, Apache-2.0.
// Read-side projections of the event fold: graph, facts, snapshot and timeline.

import type { EventStore } from "./store.js";
import type { Entity, Fact, Relationship, WorldEvent } from "./types.js";

export function validAt(rel: Relationship, at: string): boolean {
  if (rel.validFrom && at < rel.validFrom) return false;
  if (rel.validTo && at >= rel.validTo) return false;
  return true;
}

/** An edge qualifies when it matches the filters; closed edges count only for a point-in-time query. */
function matches(rel: Relationship, opts?: { via?: string; inContext?: string; at?: string }): boolean {
  if (opts?.via && rel.type !== opts.via) return false;
  if (opts?.inContext && rel.context !== opts.inContext) return false;
  return opts?.at ? validAt(rel, opts.at) : !rel.validTo;
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

export class GraphView {
  constructor(private readonly store: EventStore) {}

  entity(id: string): Entity | undefined {
    return this.store.state.entities.get(this.store.resolveAlias(id));
  }

  /** Entities linked to `id`. Closed edges are left out unless a point in time is given. */
  neighborsOf(id: string, opts?: { via?: string; inContext?: string; at?: string }): Entity[] {
    const rid = this.store.resolveAlias(id);
    const out: Entity[] = [];
    for (const rel of this.store.state.relationships.values()) {
      if (!matches(rel, opts)) continue;
      const other = rel.from === rid ? rel.to : rel.to === rid ? rel.from : undefined;
      const entity = other === undefined ? undefined : this.store.state.entities.get(other);
      if (entity) out.push(entity);
    }
    return out.sort(byId);
  }

  incoming(id: string, opts?: { via?: string }): Entity[] {
    const rid = this.store.resolveAlias(id);
    const out: Entity[] = [];
    for (const rel of this.store.state.relationships.values()) {
      if (rel.to !== rid || rel.validTo || (opts?.via && rel.type !== opts.via)) continue;
      const entity = this.store.state.entities.get(rel.from);
      if (entity) out.push(entity);
    }
    return out.sort(byId);
  }

  entitiesInContext(contextId: string, opts?: { type?: string }): Entity[] {
    const seen = new Map<string, Entity>();
    for (const rel of this.store.state.relationships.values()) {
      if (rel.context !== contextId) continue;
      for (const id of [rel.from, rel.to]) {
        const entity = this.store.state.entities.get(id);
        if (entity && (!opts?.type || entity.type === opts.type)) seen.set(entity.id, entity);
      }
    }
    return [...seen.values()].sort(byId);
  }

  /** Breadth-first walk along one relationship type, bounded by depth. */
  traverse(
    startId: string,
    opts: { via: string; direction: "ancestors" | "descendants"; maxDepth?: number },
  ): Entity[] {
    const maxDepth = opts.maxDepth ?? 5;
    const out: Entity[] = [];
    const visited = new Set<string>();
    let frontier = [this.store.resolveAlias(startId)];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const fresh = frontier.flatMap((id) => this.step(id, opts)).filter((t) => !visited.has(t));
      const next = [...new Set(fresh)];
      for (const target of next) {
        visited.add(target);
        const entity = this.store.state.entities.get(target);
        if (entity) out.push(entity);
      }
      frontier = next;
    }
    return out;
  }

  private step(id: string, opts: { via: string; direction: "ancestors" | "descendants" }): string[] {
    const targets: string[] = [];
    for (const rel of this.store.state.relationships.values()) {
      if (rel.type !== opts.via || rel.validTo) continue;
      if (opts.direction === "ancestors" && rel.from === id) targets.push(rel.to);
      if (opts.direction === "descendants" && rel.to === id) targets.push(rel.from);
    }
    return targets;
  }

  query(opts: { type?: string; where?: (e: Entity) => boolean }): Entity[] {
    return [...this.store.state.entities.values()]
      .filter((e) => (!opts.type || e.type === opts.type) && (!opts.where || opts.where(e)))
      .sort(byId);
  }
}

export class FactsView {
  constructor(private readonly store: EventStore) {}

  about(id: string): Fact[] {
    const rid = this.store.resolveAlias(id);
    return [...this.store.state.facts.values()]
      .filter((f) => f.about === rid)
      .sort((a, b) => a.assertedAt.localeCompare(b.assertedAt));
  }
}

export class SnapshotView {
  constructor(private readonly store: EventStore) {}

  /** Entity state as of a timestamp (a date alone means the end of that day). */
  entityAt(id: string, at: string): Entity | undefined {
    const iso = at.length === 10 ? `${at}T23:59:59.999Z` : at;
    const state = this.store.foldUntil(iso);
    let cur = id;
    const seen = new Set<string>();
    for (let next = state.aliases.get(cur); next !== undefined && !seen.has(cur); next = state.aliases.get(cur)) {
      seen.add(cur);
      cur = next;
    }
    return state.entities.get(cur);
  }
}

export class TimelineView {
  constructor(private readonly store: EventStore) {}

  subscribe(fn: (e: WorldEvent) => void): () => void {
    return this.store.subscribe(fn);
  }

  get(): WorldEvent[] {
    return [...this.store.events];
  }
}

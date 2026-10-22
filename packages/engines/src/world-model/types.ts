// Derived from the Meterless World Model reference implementation, Apache-2.0.
// Record shapes. The five write primitives are upsertEntity, upsertContext, relate, assertFact and snapshot;
// everything else is derived.

export type ISODate = string;

export type EntityId = string;
export type ContextId = string;
export type RelationshipId = string;
export type FactId = string;
export type EventId = string;

/** Every write carries provenance. No provenance, no write. */
export type Provenance = {
  kind: "manual" | "rss" | "api" | "file" | "agent" | "pipeline" | "wire" | (string & {});
  by?: string;
  /** Observation timestamp. Record timestamps derive from this, never from the wall clock. */
  at: ISODate | Date;
  url?: string;
  checksum?: string;
  runId?: string;
};

/** Provenance after normalisation: `at` is always an ISO string internally. */
export type StoredProvenance = Omit<Provenance, "at"> & { at: ISODate };

export type Entity = {
  type: string;
  id: EntityId;
  attrs: Record<string, unknown>;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
  name?: string;
  /** Every name the sources used; the continuity anchor and merge survivor set. */
  aliases: string[];
  state: "emerging" | "active" | "archived";
  aggregates?: {
    mentionCount: number;
    firstSeenAt?: ISODate;
    lastSeenAt?: ISODate;
    linkedStoryIds: string[];
  };
};

export type Context = {
  type: string;
  id: ContextId;
  attrs: Record<string, unknown>;
  parent?: ContextId;
  startedAt?: ISODate;
  endedAt?: ISODate;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
};

/**
 * Bitemporal edge. An unset `validTo` means open-ended. A superseding observation closes the old edge
 * (sets validTo) and opens a new one; it never deletes.
 */
export type Relationship = {
  id: RelationshipId;
  from: EntityId;
  type: string;
  to: EntityId;
  context?: ContextId;
  attrs?: Record<string, unknown>;
  validFrom?: ISODate;
  validTo?: ISODate;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: ISODate;
  supersededBy?: RelationshipId;
};

export type Fact = {
  id: FactId;
  about: EntityId;
  predicate: string;
  value: unknown;
  confidence: number;
  context?: ContextId;
  source: StoredProvenance;
  assertedAt: ISODate;
  supersededBy?: FactId;
};

export type Snapshot = {
  id: string;
  at: ISODate;
  context?: ContextId;
  entities: EntityId[];
  attrs?: Record<string, unknown>;
  schemaVersion: number;
  source: StoredProvenance;
};

export type Tombstone = { targetId: string; reason?: string; at: ISODate; by?: string };

export type Alias = { aliasId: EntityId; primaryId: EntityId; mergedAt: ISODate; mergedBy: string; reason: string };

export type ViewRebuild = { view: string; at: ISODate; durationMs: number; eventsReplayed: number };

export type EventKind =
  | "upsertEntity"
  | "upsertContext"
  | "relate"
  | "assertFact"
  | "snapshot"
  | "tombstone"
  | "alias"
  | "view-rebuild";

/** Append-only log entry. State is a fold over events; views are projections of the fold. */
export type WorldEvent = {
  id: EventId;
  /** Monotonic within the namespace, set by append order and not by writer clocks. */
  seq: number;
  kind: EventKind;
  payload: Entity | Context | Relationship | Fact | Snapshot | Tombstone | Alias | ViewRebuild;
  schemaVersion: number;
  at: ISODate;
};

export type StoryAggregate = {
  id: string;
  title: string;
  memberIds: string[];
  entityNames: string[];
  entityIds: EntityId[];
  sources: string[];
  firstAt: ISODate;
  lastAt: ISODate;
  moments: { kind: string; at: ISODate }[];
};

export type ScoreSnapshot = {
  storyId: string;
  at: ISODate;
  velocity1h: number;
  velocity24h: number;
  velocity7d: number;
  trendDirection: -1 | 0 | 1;
};

/** A raw observation entering the batch or stream ingest cycle. */
export type IngestObservation = {
  /** Stable external identifier; the dedupe key derives from it. */
  externalId: string;
  type?: string;
  title: string;
  text?: string;
  at: ISODate;
  source: Provenance;
  entities?: { type: string; name: string }[];
};

export type ObservationRecord = {
  id: string;
  externalId: string;
  entityId: EntityId;
  checksum: string;
  at: ISODate;
  storyId?: string;
  entityIds?: EntityId[];
  syncedAt?: ISODate;
  stale: boolean;
};

/** An entry in the operator merge-review queue. */
export type MergeProposal = {
  id: string;
  leftId: EntityId;
  rightId: EntityId;
  leftName: string;
  rightName: string;
  similarity: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  proposedAt: ISODate;
  resolvedAt?: ISODate;
  resolvedBy?: string;
};

/** Audit log entry. Every mutation writes one. */
export type AuditEntry = {
  seq: number;
  at: ISODate;
  kind: string;
  actor: string;
  summary: string;
  eventId?: EventId;
  runId?: string;
};

export type ConflictPolicy = "most-recent-wins" | "highest-confidence-wins" | "source-priority" | "manual";

export type ResolverOptions = {
  strategy?: string | string[];
  /** Similarity at or above this auto-merges. Default 0.85. */
  autoMergeAt?: number;
  /** [lower, upper): queue for operator review. Default [0.82, autoMergeAt). */
  reviewBand?: [number, number];
};

export type WorldModelOptions = {
  /** "memory" keeps state in process; "local" persists to .world/<namespace>.json. */
  storage?: "memory" | "local";
  namespace: string;
  directory?: string;
  /** Used only for operator actions that are genuinely "now" (merge approvals, rebuilds). */
  clock?: () => Date;
  resolver?: ResolverOptions;
  conflictPolicy?: ConflictPolicy;
  /** Source-priority ranking, highest priority first. */
  sourcePriority?: string[];
};

export type IngestReport = {
  runId: string;
  processed: number;
  skippedUnchanged: number;
  clusters: number;
  eventsAppended: number;
  changed: boolean;
  /** Wall-clock step timings; reported only, never stored in state. */
  stepTimingsMs: { step: number; name: string; ms: number }[];
};

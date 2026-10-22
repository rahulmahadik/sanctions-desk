// Derived from the Meterless World Model reference implementation, Apache-2.0.
// The ingest pipeline. Idempotency contract: running the same batch again produces the same world state
// and an empty diff. Every derived timestamp comes from the OBSERVATION, never from the wall clock.

import { jaccard } from "./resolve.js";
import { canonicalJson, sha256Hex } from "./stable-ids.js";
import type { EventStore } from "./store.js";
import type { IngestObservation, IngestReport, ObservationRecord, ScoreSnapshot, StoryAggregate } from "./types.js";

const CLUSTER_JACCARD = 0.5;
const HOUR_MS = 60 * 60 * 1000;
const STALE_DAYS = 30;

export type UpsertObservation = (obs: IngestObservation) => { entityId: string; entityIds: string[] };

export function runIngestPipeline(
  store: EventStore,
  observations: IngestObservation[],
  upsert: UpsertObservation,
  timer: () => number,
): IngestReport {
  const runId = `run_${sha256Hex(canonicalJson(observations.map((o) => o.externalId))).slice(0, 12)}`;
  const timings: IngestReport["stepTimingsMs"] = [];
  const before = canonicalJson(worldStateShape(store));
  const eventsBefore = store.events.length;

  const time = <T>(step: number, name: string, fn: () => T): T => {
    const t0 = timer();
    const out = fn();
    timings.push({ step, name, ms: timer() - t0 });
    return out;
  };

  time(1, "reconcile-stale", () => markStale(store, observations));
  const { fresh, skipped } = time(2, "cluster-classify", () => splitFresh(store, observations));
  time(3, "persist-aggregates", () => {
    for (const { obs, checksum } of fresh) {
      const { entityId, entityIds } = upsert(obs);
      store.observations.set(obs.externalId, {
        id: `obs_${sha256Hex(obs.externalId).slice(0, 12)}`,
        externalId: obs.externalId,
        entityId,
        checksum,
        at: obs.at,
        entityIds,
        stale: false,
      });
    }
  });
  const clusters = time(2, "story-grouping", () => groupIntoStories(store));
  time(4, "score-measure", () => scoreStories(store, clusters));
  time(9, "rebuild-aggregates", () => rebuildAggregates(store));

  store.persist();
  const after = canonicalJson(worldStateShape(store));
  const report: IngestReport = {
    runId,
    processed: fresh.length,
    skippedUnchanged: skipped.length,
    clusters: clusters.length,
    eventsAppended: store.events.length - eventsBefore,
    changed: before !== after,
    stepTimingsMs: timings,
  };
  store.logAudit(
    "ingest",
    "pipeline",
    `run ${runId}: ${fresh.length} processed, ${skipped.length} skipped`,
    undefined,
    runId,
    observations[0]?.at,
  );
  return report;
}

function markStale(store: EventStore, observations: IngestObservation[]): void {
  const latest =
    observations
      .map((o) => o.at)
      .sort()
      .at(-1) ?? "";
  for (const rec of store.observations.values()) {
    rec.stale = latest !== "" && rec.at < isoDaysBefore(latest, STALE_DAYS);
  }
}

function splitFresh(store: EventStore, observations: IngestObservation[]) {
  const fresh: { obs: IngestObservation; checksum: string }[] = [];
  const skipped: IngestObservation[] = [];
  for (const obs of observations) {
    const checksum = sha256Hex(
      canonicalJson({ externalId: obs.externalId, title: obs.title, text: obs.text ?? "", at: obs.at }),
    );
    const existing = store.observations.get(obs.externalId);
    if (existing && existing.checksum === checksum) skipped.push(obs);
    else fresh.push({ obs, checksum });
  }
  return { fresh, skipped };
}

/** Group observations into stories by entity overlap. */
function groupIntoStories(store: EventStore): ObservationRecord[][] {
  const all = [...store.observations.values()].sort((a, b) => a.externalId.localeCompare(b.externalId));
  const used = new Set<string>();
  const clusters: ObservationRecord[][] = [];
  for (const seed of all) {
    if (used.has(seed.externalId)) continue;
    const group = [seed];
    used.add(seed.externalId);
    for (const other of all) {
      if (used.has(other.externalId)) continue;
      if (jaccard(seed.entityIds ?? [], other.entityIds ?? []) >= CLUSTER_JACCARD) {
        group.push(other);
        used.add(other.externalId);
      }
    }
    clusters.push(group);
  }
  return clusters;
}

/** Velocity is mentions per hour over bucketed windows ending at the newest observation. */
function scoreStories(store: EventStore, clusters: ObservationRecord[][]): void {
  for (const group of clusters) {
    const memberIds = group.map((g) => g.externalId).sort();
    const storyId = `story_${sha256Hex(canonicalJson(memberIds)).slice(0, 12)}`;
    const times = group.map((g) => Date.parse(g.at)).sort((a, b) => a - b);
    const first = times[0] ?? 0;
    const lastAt = times.at(-1) ?? first;
    const velocity = (windowMs: number) => times.filter((t) => t > lastAt - windowMs).length / (windowMs / HOUR_MS);
    const prevHour = times.filter((t) => t > lastAt - 2 * HOUR_MS && t <= lastAt - HOUR_MS).length;
    const currHour = times.filter((t) => t > lastAt - HOUR_MS).length;
    const score: ScoreSnapshot = {
      storyId,
      at: new Date(lastAt).toISOString(),
      velocity1h: velocity(HOUR_MS),
      velocity24h: velocity(24 * HOUR_MS),
      velocity7d: velocity(7 * 24 * HOUR_MS),
      trendDirection: Math.sign(currHour - prevHour) as -1 | 0 | 1,
    };
    store.scores = store.scores.filter((s) => s.storyId !== storyId);
    store.scores.push(score);

    const entityIds = [...new Set(group.flatMap((g) => g.entityIds ?? []))].sort();
    const second = times[1];
    const story: StoryAggregate = {
      id: storyId,
      title: group[0]?.externalId ?? storyId,
      memberIds,
      entityNames: entityIds,
      entityIds,
      sources: [],
      firstAt: new Date(first).toISOString(),
      lastAt: new Date(lastAt).toISOString(),
      moments: second !== undefined ? [{ kind: "multi-source", at: new Date(second).toISOString() }] : [],
    };
    store.stories.set(storyId, story);
    for (const rec of group) rec.storyId = storyId;
  }
}

export function rebuildAggregates(store: EventStore): void {
  for (const entity of store.state.entities.values()) {
    const mentions = [...store.observations.values()].filter((o) => o.entityIds?.includes(entity.id));
    if (mentions.length === 0) continue;
    const times = mentions.map((m) => m.at).sort();
    entity.aggregates = {
      mentionCount: mentions.length,
      firstSeenAt: times[0],
      lastSeenAt: times.at(-1),
      linkedStoryIds: [...new Set(mentions.map((m) => m.storyId).filter((s): s is string => !!s))].sort(),
    };
  }
}

/** The idempotency diff surface: everything derived from observations, in canonical form. */
export function worldStateShape(store: EventStore): unknown {
  return {
    entities: [...store.state.entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
    contexts: [...store.state.contexts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...store.state.relationships.values()].sort((a, b) => a.id.localeCompare(b.id)),
    facts: [...store.state.facts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    observations: [...store.observations.values()].sort((a, b) => a.externalId.localeCompare(b.externalId)),
    stories: [...store.stories.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function isoDaysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 24 * 60 * 60 * 1000).toISOString();
}

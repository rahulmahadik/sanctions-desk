import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decide,
  entityIdFromName,
  type IngestObservation,
  jaccard,
  levenshtein,
  nameSimilarity,
  normalizeName,
  sha256Hex,
  WorldModel,
} from "../src/world-model/index.js";

const clock = () => new Date("2026-05-18T00:00:00.000Z");
const at = (s: string) => ({ kind: "manual", at: s });
const T = "2026-01-01T00:00:00.000Z";

const OBS: IngestObservation[] = [
  {
    externalId: "a1",
    title: "Fed holds rates",
    at: "2026-05-17T14:00:00.000Z",
    source: { kind: "rss", at: "2026-05-17T14:00:00.000Z" },
    entities: [{ type: "person", name: "Jerome Powell" }],
  },
  {
    externalId: "a2",
    title: "Powell signals patience",
    at: "2026-05-17T16:30:00.000Z",
    source: { kind: "rss", at: "2026-05-17T16:30:00.000Z" },
    entities: [{ type: "person", name: "Jerome Powell" }],
  },
];

describe("stable ids and resolution maths", () => {
  it("hashes, canonicalises and normalises names", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(normalizeName(" Zoë  Núñez​ ")).toBe("zoe nunez");
    expect(entityIdFromName("org", "Acme Corp")).toMatch(/^ent_[a-f0-9]{16}$/);
  });

  it("measures similarity and bands the decision at the boundaries", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(nameSimilarity("Jose", "José")).toBe(1);
    expect(nameSimilarity("", "")).toBe(1);
    expect(decide(0.85)).toBe("auto-merge");
    expect(decide(0.82)).toBe("review");
    expect(decide(0.8199)).toBe("new");
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
  });
});

describe("writes", () => {
  it("requires a namespace and provenance on every write", async () => {
    expect(() => new WorldModel({ namespace: "" })).toThrow(/namespace/);
    const world = new WorldModel({ namespace: "t" });
    await expect(world.upsertEntity({ type: "x", name: "n", source: undefined })).rejects.toThrow(/provenance/);
    await expect(world.upsertEntity({ type: "x", source: at(T) })).rejects.toThrow(/need a name/);
    await expect(world.relate({ from: "a", type: "r", to: "b", source: undefined })).rejects.toThrow(/provenance/);
  });

  it("merges near duplicates automatically and queues borderline ones for review", async () => {
    const world = new WorldModel({ namespace: "t", clock });
    await world.upsertEntity({ type: "org", name: "Northern Trading Company", source: at(T) });
    const merged = await world.upsertEntity({ type: "org", name: "Northern Trading Company.", source: at(T) });
    expect(merged.id).toBe(entityIdFromName("org", "Northern Trading Company"));

    // 20 of 24 characters match: similarity 0.833, inside the review band.
    await world.upsertEntity({ type: "org", name: "abcdefghijklmnopqrstuvwx", source: at(T) });
    await world.upsertEntity({ type: "org", name: "abcdefghijklmnopqrst0000", source: at(T) });
    const queue = world.mergeQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.status).toBe("pending");
    await world.upsertEntity({ type: "org", name: "abcdefghijklmnopqrst0000", source: at(T) });
    expect(world.mergeQueue()).toHaveLength(1);

    const proposal = queue[0] ?? fail("no proposal");
    await world.approveMerge(proposal.id, "reviewer");
    expect(world.view("graph").entity(proposal.leftId)?.id).toBe(proposal.rightId);
    await expect(world.approveMerge(proposal.id, "reviewer")).rejects.toThrow(/no pending merge/);
  });

  it("rejects a merge proposal and keeps the entities apart", async () => {
    const world = new WorldModel({ namespace: "t", clock });
    await world.upsertEntity({ type: "org", name: "abcdefghijklmnopqrstuvwx", source: at(T) });
    await world.upsertEntity({ type: "org", name: "abcdefghijklmnopqrst0000", source: at(T) });
    const proposal = world.mergeQueue()[0] ?? fail("no proposal");
    await world.rejectMerge(proposal.id, "reviewer");
    expect(world.mergeQueue()[0]?.status).toBe("rejected");
    await expect(world.rejectMerge(proposal.id, "reviewer")).rejects.toThrow(/no pending merge/);
  });

  it("stores contexts, hashes attribute-keyed contexts with their parent, and relates entities once", async () => {
    const world = new WorldModel({ namespace: "t" });
    const season = await world.upsertContext({
      type: "season",
      externalKey: { system: "g", id: "145" },
      source: at(T),
    });
    expect(season.id).toBe("season:g:145");
    const w14a = await world.upsertContext({ type: "week", attrs: { n: 14 }, parent: "season:g:145", source: at(T) });
    const w14b = await world.upsertContext({ type: "week", attrs: { n: 14 }, parent: "season:g:144", source: at(T) });
    expect(w14a.id).not.toBe(w14b.id);
    await world.upsertContext({ type: "week", attrs: { n: 14, note: "x" }, parent: "season:g:145", source: at(T) });

    await world.upsertEntity({ type: "p", externalKey: { system: "g", id: "1" }, source: at(T) });
    await world.upsertEntity({ type: "p", externalKey: { system: "g", id: "2" }, source: at(T) });
    const first = await world.relate({ from: "p:g:1", type: "knows", to: "p:g:2", context: w14a.id, source: at(T) });
    const again = await world.relate({ from: "p:g:1", type: "knows", to: "p:g:2", context: w14a.id, source: at(T) });
    expect(again.id).toBe(first.id);
    const graph = world.view("graph");
    expect(graph.entitiesInContext(w14a.id).map((e) => e.id)).toEqual(["p:g:1", "p:g:2"]);
    expect(graph.entitiesInContext(w14a.id, { type: "q" })).toEqual([]);
    expect(graph.incoming("p:g:2", { via: "knows" }).map((e) => e.id)).toEqual(["p:g:1"]);
    expect(graph.incoming("p:g:2", { via: "other" })).toEqual([]);
    expect(graph.neighborsOf("p:g:2", { inContext: "none" })).toEqual([]);
    expect(graph.query({ type: "p", where: (e) => e.id.endsWith("2") }).map((e) => e.id)).toEqual(["p:g:2"]);
  });

  it("walks ancestors and descendants to a depth limit", async () => {
    const world = new WorldModel({ namespace: "t" });
    for (const id of ["a", "b", "c", "d"]) {
      await world.upsertEntity({ type: "n", externalKey: { system: "s", id }, source: at(T) });
    }
    await world.relate({ from: "n:s:a", type: "owns", to: "n:s:b", source: at(T) });
    await world.relate({ from: "n:s:b", type: "owns", to: "n:s:c", source: at(T) });
    await world.relate({ from: "n:s:c", type: "owns", to: "n:s:d", source: at(T) });
    const graph = world.view("graph");
    expect(graph.traverse("n:s:a", { via: "owns", direction: "ancestors" }).map((e) => e.id)).toEqual([
      "n:s:b",
      "n:s:c",
      "n:s:d",
    ]);
    expect(graph.traverse("n:s:a", { via: "owns", direction: "ancestors", maxDepth: 1 }).map((e) => e.id)).toEqual([
      "n:s:b",
    ]);
    expect(graph.traverse("n:s:d", { via: "owns", direction: "descendants" }).map((e) => e.id)).toEqual([
      "n:s:c",
      "n:s:b",
      "n:s:a",
    ]);
  });
});

describe("facts and conflict policy", () => {
  it("applies most-recent-wins by default and creates a missing subject", async () => {
    const world = new WorldModel({ namespace: "t" });
    await world.assertFact({
      about: "company:x:1",
      predicate: "rating",
      value: "low",
      source: at("2026-01-01T00:00:00.000Z"),
    });
    await world.assertFact({
      about: "company:x:1",
      predicate: "rating",
      value: "high",
      source: at("2026-02-01T00:00:00.000Z"),
    });
    const entity = world.view("graph").entity("company:x:1");
    expect(entity?.attrs.rating).toBe("high");
    expect(entity?.state).toBe("emerging");
    const facts = world.view("facts").about("company:x:1");
    expect(facts).toHaveLength(2);
    expect(facts.filter((f) => f.supersededBy)).toHaveLength(1);
    const dup = await world.assertFact({
      about: "company:x:1",
      predicate: "rating",
      value: "high",
      source: at("2026-02-01T00:00:00.000Z"),
    });
    expect(dup.value).toBe("high");
    expect(world.view("facts").about("company:x:1")).toHaveLength(2);
  });

  it("supports highest-confidence and source-priority policies", async () => {
    const byConfidence = new WorldModel({ namespace: "t", conflictPolicy: "highest-confidence-wins" });
    await byConfidence.assertFact({
      about: "e:s:1",
      predicate: "p",
      value: "sure",
      confidence: 0.9,
      source: at("2026-01-01T00:00:00.000Z"),
    });
    await byConfidence.assertFact({
      about: "e:s:1",
      predicate: "p",
      value: "unsure",
      confidence: 0.2,
      source: at("2026-03-01T00:00:00.000Z"),
    });
    expect(byConfidence.view("graph").entity("e:s:1")?.attrs.p).toBe("sure");

    const byPriority = new WorldModel({
      namespace: "t",
      conflictPolicy: "source-priority",
      sourcePriority: ["registry", "rss"],
    });
    await byPriority.assertFact({
      about: "e:s:1",
      predicate: "p",
      value: "from rss",
      source: { kind: "rss", at: "2026-03-01T00:00:00.000Z" },
    });
    await byPriority.assertFact({
      about: "e:s:1",
      predicate: "p",
      value: "from registry",
      source: { kind: "registry", at: "2026-01-01T00:00:00.000Z" },
    });
    expect(byPriority.view("graph").entity("e:s:1")?.attrs.p).toBe("from registry");
  });
});

describe("views, ingest and persistence", () => {
  it("reports entity state as of a date", async () => {
    const world = new WorldModel({ namespace: "t" });
    await world.upsertEntity({
      type: "p",
      externalKey: { system: "g", id: "1" },
      attrs: { v: 1 },
      source: at("2026-01-01T00:00:00.000Z"),
    });
    await world.upsertEntity({
      type: "p",
      externalKey: { system: "g", id: "1" },
      attrs: { v: 2 },
      source: at("2026-03-01T00:00:00.000Z"),
    });
    const snapshot = world.view("snapshot");
    expect(snapshot.entityAt("p:g:1", "2026-02-01")?.attrs.v).toBe(1);
    expect(snapshot.entityAt("p:g:1", "2026-04-01T00:00:00.000Z")?.attrs.v).toBe(2);
    expect(snapshot.entityAt("p:g:9", "2026-04-01")).toBeUndefined();
  });

  it("groups observations into stories, scores velocity and fills aggregates", async () => {
    const world = new WorldModel({ namespace: "t", clock });
    const report = await world.ingest(OBS);
    expect(report).toMatchObject({ processed: 2, skippedUnchanged: 0, clusters: 1, changed: true });
    expect(report.stepTimingsMs.length).toBeGreaterThan(3);
    const powell = world.view("graph").entity(entityIdFromName("person", "Jerome Powell"));
    expect(powell?.aggregates?.mentionCount).toBe(2);
    expect(powell?.aggregates?.linkedStoryIds).toHaveLength(1);
    const again = await world.ingest(OBS);
    expect(again).toMatchObject({ processed: 0, skippedUnchanged: 2, changed: false });
    expect(world.events().length).toBeGreaterThan(4);
    expect(JSON.stringify(world.stateShape())).toContain("story_");
  });

  it("marks old observations stale against the newest batch", async () => {
    const world = new WorldModel({ namespace: "t", clock });
    await world.ingest([
      {
        ...OBS[0],
        at: "2026-01-01T00:00:00.000Z",
        source: { kind: "rss", at: "2026-01-01T00:00:00.000Z" },
      } as IngestObservation,
    ]);
    await world.ingest([OBS[1] as IngestObservation]);
    expect(JSON.stringify(world.stateShape())).toContain('"stale":true');
  });

  it("supports custom views, timeline subscribers and unknown view names", async () => {
    const world = new WorldModel({ namespace: "t" });
    const seen: string[] = [];
    world.view("timeline").subscribe((e) => seen.push(e.kind));
    const stop = world.subscribeEvents(() => seen.push("any"));
    world.registerView("entity-count", {
      events: ["upsertEntity"],
      initialState: 0,
      reducer: (n) => (n as number) + 1,
    });
    await world.upsertEntity({ type: "p", externalKey: { system: "g", id: "1" }, source: at(T) });
    await world.upsertEntity({ type: "p", externalKey: { system: "g", id: "2" }, source: at(T) });
    stop();
    expect(world.view("entity-count").get()).toBe(2);
    expect(world.view("timeline").get()).toHaveLength(2);
    expect(seen).toContain("upsertEntity");
    expect(() => world.view("missing")).toThrow(/unknown view/);
  });

  it("persists to disk, reloads the same state and keeps the audit trail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "world-"));
    const a = new WorldModel({ namespace: "persist", storage: "local", directory: dir, clock });
    await a.ingest(OBS);
    await a.upsertEntity({ type: "org", name: "Reload Co", source: at(T) });
    const b = new WorldModel({ namespace: "persist", storage: "local", directory: dir, clock });
    expect(b.stateShapeCanonical()).toBe(a.stateShapeCanonical());
    expect(b.audit().length).toBe(a.audit().length);
    const next = await b.upsertEntity({ type: "org", name: "Another Co", source: at(T) });
    expect(b.audit().at(-1)?.seq).toBeGreaterThan(a.audit().at(-1)?.seq ?? 0);
    expect(next.name).toBe("Another Co");
  });
});

function fail(message: string): never {
  throw new Error(message);
}

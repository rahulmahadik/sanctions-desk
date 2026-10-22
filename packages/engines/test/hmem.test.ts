import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cosine, DAY_MS, embed, HMEM, jaccard, parseStrictJsonArray, tokenize } from "../src/hmem/index.js";

const T0 = 1_750_000_000_000;

function fresh(clock: { now: number } = { now: T0 }) {
  return { hmem: new HMEM({ clock: () => clock.now }), clock };
}

describe("embeddings", () => {
  it("are deterministic, unit length and similar for similar text", () => {
    expect(embed("Prefer TypeScript for services")).toEqual(embed("Prefer TypeScript for services"));
    const v = embed("docker compose deploy");
    expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    expect(cosine(embed("deploy the docker server"), embed("docker server deploy"))).toBeGreaterThan(
      cosine(embed("deploy the docker server"), embed("banana smoothie recipe")),
    );
    expect(embed("")).toEqual(new Array(64).fill(0));
  });
  it("tokenises and compares sets", () => {
    expect(tokenize("A big Dog, 2 cats!")).toEqual(["big", "dog", "cats"]);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], ["a"])).toBe(0);
  });
});

describe("store", () => {
  it("rejects a record without a source and enriches the ones it keeps", () => {
    const { hmem } = fresh();
    expect(() => hmem.add({ content: "x", source: "  " })).toThrow(/no source/);
    const a = hmem.add({ content: "We deploy the api to Docker on Fridays", source: "t", tags: ["tech:ops"] });
    expect(a).toMatchObject({ domain: "tech", namespace: "tech/notes", layer: "working", confidence: 0.7 });
    expect(a.entities).toContain("docker");
    const b = hmem.add({ content: "Docker deploy runs for the api server", source: "t" });
    expect(b.relatedTo).toContain(a.id);
    expect(hmem.store.get(a.id)?.relatedTo).toContain(b.id);
  });

  it("classifies by project tag, keywords and type", () => {
    const { hmem } = fresh();
    expect(hmem.store.classifyDomain("anything", ["project:atlas"], "general")).toBe("atlas");
    expect(hmem.store.classifyDomain("the client deadline moved", [], "general")).toBe("work");
    expect(hmem.store.classifyDomain("I like mornings", [], "preference")).toBe("personal");
    expect(hmem.store.classifyDomain("nothing here", [], "general")).toBe("general");
  });

  it("marks a correction as superseding the earlier similar record", () => {
    const { hmem } = fresh();
    const first = hmem.add({ content: "The database is Postgres for the billing service", source: "t" });
    const second = hmem.add({
      content: "Actually the database is Postgres for the billing service",
      source: "t",
    });
    expect(second.supersedes).toBe(first.id);
  });

  it("updates, promotes, touches, deletes and logs each change", () => {
    const { hmem } = fresh();
    const m = hmem.add({ content: "record to change", source: "t" });
    hmem.store.update(m.id, { domain: "work" });
    hmem.store.promote(m.id, "long_term");
    hmem.store.touch(m.id);
    expect(hmem.store.get(m.id)).toMatchObject({ domain: "work", layer: "long_term", accessCount: 1 });
    hmem.store.delete(m.id, "test");
    expect(hmem.store.get(m.id)).toBeUndefined();
    expect(hmem.ledger.history(m.id).map((e) => e.action)).toEqual(["create", "update", "promote", "delete"]);
    expect(() => hmem.store.update("nope", {})).toThrow(/unknown memory id/);
    expect(hmem.ledger.stats()).toMatchObject({ create: 1, delete: 1 });
    expect(hmem.ledger.all()).toHaveLength(4);
  });

  it("persists state and the ledger to disk and reloads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "hmem-"));
    const a = new HMEM({ clock: () => T0, persistDir: dir });
    const m = a.add({ content: "persisted memory", source: "t" });
    a.feedback(m.id, "helpful");
    const b = new HMEM({ clock: () => T0, persistDir: dir });
    expect(b.store.get(m.id)?.confidence).toBeCloseTo(0.75);
    expect(b.ledger.history(m.id).map((e) => e.action)).toEqual(["create", "feedback"]);
    expect(b.add({ content: "next", source: "t" }).id).toBe("mem-2");
  });
});

describe("retrieval", () => {
  it("ranks relevant records first, honours the threshold and the chat scope, and formats reinjection", () => {
    const { hmem } = fresh();
    const docker = hmem.add({ content: "Deploy the Docker server on Friday", source: "t", layer: "long_term" });
    hmem.add({ content: "Banana smoothie with oat milk", source: "t" });
    const scoped = hmem.add({ content: "Docker note for another chat", source: "t", chatId: "other" });
    const result = hmem.query("how do we deploy the docker server", { chatId: "mine" });
    const ids = result.memories.map((m) => m.memory.id);
    expect(ids[0]).toBe(docker.id);
    expect(ids).not.toContain(scoped.id);
    expect(result.context).toContain("[MEMORY CONTEXT]");
    expect(result.context).toContain("[LT] Deploy the Docker server on Friday");
    expect(result.trace.strategy).toBe("minimal");
    expect(hmem.store.get(docker.id)?.accessCount).toBe(1);
    expect(hmem.query("zzz unrelated", { threshold: 0.99 }).context).toBe("");
    expect(hmem.retrieval.scoreOne(docker, "docker server deploy")).toBeGreaterThan(0.3);
  });

  it("uses the personal strategy when preferences are retrieved", () => {
    const { hmem } = fresh();
    hmem.add({ content: "I prefer short morning meetings with the client", source: "t", type: "preference" });
    hmem.add({ content: "Client meetings should be short in the morning", source: "t", type: "preference" });
    const result = hmem.query("short morning client meetings", { threshold: 0 });
    expect(result.trace.strategy).toBe("personal");
  });

  it("rejects feedback on an unknown record", () => {
    expect(() => fresh().hmem.feedback("nope", "helpful")).toThrow(/unknown memory id/);
  });
});

describe("mining", () => {
  it("extracts signal sentences without a model and stores them short term", async () => {
    const { hmem } = fresh();
    const records = await hmem.mine(
      "user_correction",
      "We decided to always use the shared ledger for audits. Hello there. It is important to remember the retention rule.",
      { chatId: "c1" },
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      layer: "short_term",
      type: "preference",
      chatId: "c1",
      source: "interaction:user_correction",
    });
  });

  it("uses a model hook when given and tolerates noisy output", async () => {
    const calls: string[] = [];
    const hmem = new HMEM({
      clock: () => T0,
      minerFn: async (prompt) => {
        calls.push(prompt);
        return 'Sure!\n```json\n["The retention period is seven years", "x"]\n```';
      },
    });
    const records = await hmem.mining.mineInteraction("file_save", "text");
    expect(records.map((r) => r.content)).toEqual(["The retention period is seven years"]);
    expect(records[0]?.layer).toBe("working");
    const docs = await hmem.mining.mineDocument("policy.md", "ignored");
    expect(docs[0]?.tags).toContain("file:policy.md");
    expect(calls).toHaveLength(2);
  });

  it("mines documents without a model", async () => {
    const { hmem } = fresh();
    const docs = await hmem.mining.mineDocument("a.md", "You must always escalate a strong match to a person.");
    expect(docs).toHaveLength(1);
  });

  it("parses model output defensively", () => {
    expect(parseStrictJsonArray("not json")).toEqual([]);
    expect(parseStrictJsonArray('{"a": 1}')).toEqual([]);
    expect(parseStrictJsonArray('prefix ["hello world", 4, "tiny"] suffix')).toEqual(["hello world"]);
  });
});

describe("sleep cycle", () => {
  it("previews without changing anything, consolidates, archives, synthesises and can restore", () => {
    const clock = { now: T0 };
    const { hmem } = fresh(clock);
    const shortTerm = hmem.add({ content: "short term note about lunch", source: "t", layer: "short_term" });
    const old = hmem.add({ content: "an old plain record about parking", source: "t" });
    const twinA = hmem.add({ content: "Docker deploy runs on the api server", source: "t", layer: "long_term" });
    const twinB = hmem.add({ content: "Docker deploy runs on the api server", source: "t", layer: "long_term" });
    clock.now = T0 + 40 * DAY_MS;
    hmem.store.touch(twinA.id);
    hmem.store.touch(twinA.id);
    hmem.store.touch(twinA.id);

    const before = hmem.store.all().length;
    const plan = hmem.sleep.preview();
    expect(hmem.store.all()).toHaveLength(before);
    expect(plan.toConsolidate).toContain(shortTerm.id);
    expect(plan.toArchive).toContain(old.id);
    expect(plan.toSynthesize.flat()).toEqual(expect.arrayContaining([twinA.id, twinB.id]));

    const report = hmem.sleep.execute(plan);
    expect(report).toMatchObject({ consolidated: 1, synthesized: 1 });
    expect(report.actionLog.some((l) => l.startsWith("synthesized"))).toBe(true);
    expect(hmem.store.get(old.id)).toBeUndefined();
    expect(hmem.store.all().some((m) => m.source === "sleep:synthesis" && (m.derivedFrom ?? []).length === 2)).toBe(
      true,
    );

    hmem.sleep.restore(report.backupId);
    expect(hmem.store.get(old.id)).toBeDefined();
    expect(() => hmem.sleep.restore("backup-99")).toThrow(/unknown backup/);
    expect(hmem.ledger.stats().restore).toBe(1);
  });

  it("never archives a relationship hub or a superseding record", () => {
    const clock = { now: T0 };
    const { hmem } = fresh(clock);
    const hub = hmem.add({ content: "Docker hub record one", source: "t" });
    for (const n of ["two", "three", "four"]) hmem.add({ content: `Docker spoke ${n} record`, source: "t" });
    const superseding = hmem.add({ content: "plain record superseding another", source: "t", supersedes: hub.id });
    clock.now = T0 + 90 * DAY_MS;
    const plan = hmem.sleep.preview();
    expect(plan.toArchive).not.toContain(superseding.id);
    expect(plan.toArchive).not.toContain(hub.id);
  });
});

describe("conflicts", () => {
  it("detects opposing phrases, resolves clear winners and queues the rest", () => {
    const { hmem } = fresh();
    const a = hmem.add({ content: "Always enable the nightly backup job", source: "t", confidence: 0.95 });
    const b = hmem.add({ content: "Never enable the nightly backup job", source: "t", confidence: 0.2 });
    const found = hmem.conflicts.scan();
    expect(found.length).toBeGreaterThan(0);
    const outcome = hmem.conflicts.autoResolve(found[0] ?? fail("no conflict"));
    expect(["resolved", "queued"]).toContain(outcome);
    expect(hmem.store.get(a.id) && hmem.store.get(b.id)).toBeTruthy();
    expect(hmem.conflicts.queue()).toHaveLength(outcome === "resolved" ? 0 : 1);
    if (outcome === "resolved") {
      const loser = [hmem.store.get(a.id), hmem.store.get(b.id)].find((m) => m?.supersededBy);
      expect(loser).toBeDefined();
    }
  });

  it("detects conflicting numbers and leaves intended replacements alone", () => {
    const { hmem } = fresh();
    hmem.add({ content: "The retention period for audit logs is 7 years", source: "t" });
    hmem.add({ content: "The retention period for audit logs is 5 years", source: "t" });
    const found = hmem.conflicts.scan();
    expect(found.some((c) => c.reason.includes("numeric"))).toBe(true);

    const other = fresh().hmem;
    const old = other.add({ content: "Always use the shared ledger for audits", source: "t" });
    other.add({ content: "Actually never use the shared ledger for audits", source: "t", supersedes: old.id });
    expect(other.conflicts.scan()).toHaveLength(0);
  });

  it("queues a conflict with a thin margin and refuses to resolve a deleted record", () => {
    const { hmem } = fresh();
    const a = hmem.add({ content: "Always enable the nightly backup job", source: "t" });
    const b = hmem.add({ content: "Never enable the nightly backup job", source: "t" });
    const found = hmem.conflicts.scan();
    const conflict = found[0] ?? fail("no conflict");
    expect(hmem.conflicts.autoResolve({ ...conflict, confidence: 0.1 })).toBe("queued");
    hmem.store.delete(a.id, "gone");
    expect(() => hmem.conflicts.autoResolve(conflict)).toThrow(/no longer exists/);
    expect(b.id).toBeTruthy();
  });
});

describe("dreaming", () => {
  it("proposes insights, domains and invariants; approving creates lineage; rejecting does not", () => {
    const { hmem } = fresh();
    hmem.add({ content: "I prefer the client deadline review in the morning", source: "t", type: "preference" });
    hmem.add({ content: "I prefer morning review of the client deadline", source: "t", type: "preference" });
    hmem.add({ content: "Plain note with the docker api server", source: "t", tags: [] });
    const proposals = hmem.dreaming.dream();
    const kinds = new Set(proposals.map((p) => p.type));
    expect(kinds.has("insight") || kinds.has("invariant")).toBe(true);
    expect(hmem.dreaming.pending()).toHaveLength(proposals.length);
    expect(hmem.store.all()).toHaveLength(3);

    const insight = proposals.find((p) => p.type === "insight" || p.type === "invariant") ?? fail("none");
    const created = hmem.dreaming.approve(insight.id);
    expect(created?.layer).toBe("long_term");
    expect(created?.derivedFrom?.length).toBeGreaterThan(0);
    expect(() => hmem.dreaming.approve(insight.id)).toThrow(/no pending proposal/);

    const other = proposals.find((p) => p.id !== insight.id);
    if (other) {
      hmem.dreaming.reject(other.id);
      expect(hmem.dreaming.pending().some((p) => p.id === other.id)).toBe(false);
    }
  });

  it("applies a domain suggestion without creating a record", () => {
    const { hmem } = fresh();
    const m = hmem.add({ content: "Plan the sprint review with the client", source: "t", tags: ["misc"] });
    hmem.store.update(m.id, { domain: "general" });
    const domain = hmem.dreaming.dream().find((p) => p.type === "domain") ?? fail("no domain proposal");
    expect(hmem.dreaming.approve(domain.id)).toBeUndefined();
    expect(hmem.store.get(m.id)?.domain).toBe(domain.suggestedDomain);
  });
});

function fail(message: string): never {
  throw new Error(message);
}

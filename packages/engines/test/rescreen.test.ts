import { describe, expect, it } from "vitest";
import {
  type CurrentEntry,
  type DispositionRef,
  type EarlierDecision,
  type EntryLookup,
  judgeDisposition,
  rescreen,
} from "../src/domain/rescreen.js";

const sha = (c: string) => c.repeat(64);

function disposition(n: number, decision: EarlierDecision = "CLOSE_FALSE_POSITIVE", hash = sha("a")): DispositionRef {
  return {
    disposition_id: `D-${n}`,
    customer_id: `CUST-${n}`,
    entry_id: `OFAC-${n}`,
    decision,
    entry_content_hash: hash,
  };
}

function lookupOf(entries: Record<string, CurrentEntry | undefined>): { lookup: EntryLookup; calls: string[][] } {
  const calls: string[][] = [];
  const lookup: EntryLookup = async (ids) => {
    calls.push([...ids]);
    const found = new Map<string, CurrentEntry>();
    for (const id of ids) {
      const entry = entries[id];
      if (entry) found.set(id, entry);
    }
    return found;
  };
  return { lookup, calls };
}

describe("judgeDisposition", () => {
  const d = disposition(1);
  it("finds an unchanged entry, a changed entry and a removed entry", () => {
    expect(judgeDisposition(d, { content_hash: sha("a") }).kind).toBe("unchanged");
    const changed = judgeDisposition(d, { content_hash: sha("b"), list_snapshot_id: "ofac-new" });
    expect(changed.kind).toBe("reopen");
    expect(changed.candidate).toMatchObject({
      reason_code: "ENTRY_CHANGED",
      earlier_hash: sha("a"),
      current_hash: sha("b"),
      current_snapshot_id: "ofac-new",
    });
    expect(judgeDisposition(d, undefined).kind).toBe("moot");
  });

  it("releases a removed entry only when the earlier decision held someone", () => {
    for (const decision of ["ESCALATE_L2", "RECOMMEND_BLOCK"] as const) {
      const verdict = judgeDisposition(disposition(1, decision), undefined);
      expect(verdict.kind).toBe("release");
      expect(verdict.candidate?.reason_code).toBe("ENTRY_DELISTED");
      expect(verdict.candidate?.current_hash).toBeUndefined();
    }
    expect(judgeDisposition(disposition(1, "NEED_MORE_INFO"), undefined).kind).toBe("moot");
  });

  it("re-opens a changed entry whatever the earlier decision was", () => {
    for (const decision of ["CLOSE_FALSE_POSITIVE", "ESCALATE_L2", "RECOMMEND_BLOCK", "NEED_MORE_INFO"] as const) {
      expect(judgeDisposition(disposition(1, decision), { content_hash: sha("z") }).kind).toBe("reopen");
    }
  });
});

describe("rescreen", () => {
  const all = [
    disposition(1),
    disposition(2),
    disposition(3, "ESCALATE_L2"),
    disposition(4, "CLOSE_FALSE_POSITIVE"),
    disposition(5, "RECOMMEND_BLOCK"),
  ];
  const entries: Record<string, CurrentEntry | undefined> = {
    "OFAC-1": { content_hash: sha("a") },
    "OFAC-2": { content_hash: sha("changed") },
    "OFAC-3": undefined,
    "OFAC-4": undefined,
    "OFAC-5": { content_hash: sha("a") },
  };

  it("sorts every disposition into re-open, release, moot or unchanged, in bounded batches", async () => {
    const { lookup, calls } = lookupOf(entries);
    const result = await rescreen(all, lookup, { batchSize: 2 });
    expect(result).toMatchObject({
      total: 5,
      examined: 5,
      batches: 3,
      complete: true,
      nextCursor: null,
      status: "completed",
    });
    expect(result.reopen.map((c) => c.disposition_id)).toEqual(["D-2"]);
    expect(result.release.map((c) => c.disposition_id)).toEqual(["D-3"]);
    expect(result).toMatchObject({ unchanged: 2, moot: 1 });
    expect(calls).toEqual([["OFAC-1", "OFAC-2"], ["OFAC-3", "OFAC-4"], ["OFAC-5"]]);
  });

  it("stops at the batch limit, returns a cursor, and resumes from it", async () => {
    const { lookup } = lookupOf(entries);
    const first = await rescreen(all, lookup, { batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ examined: 2, complete: false, nextCursor: 2, status: "max-chunks" });
    expect(first.reopen.map((c) => c.disposition_id)).toEqual(["D-2"]);
    const rest = await rescreen(all, lookup, { batchSize: 2, startCursor: first.nextCursor ?? 0 });
    expect(rest).toMatchObject({ examined: 3, complete: true });
    expect(rest.release.map((c) => c.disposition_id)).toEqual(["D-3"]);
    expect([...first.reopen, ...rest.reopen]).toHaveLength(1);
  });

  it("looks up each entry once per batch even when several cases share it", async () => {
    const shared = [
      disposition(1),
      { ...disposition(2), entry_id: "OFAC-1" },
      { ...disposition(3), entry_id: "OFAC-1" },
    ];
    const { lookup, calls } = lookupOf({ "OFAC-1": { content_hash: sha("x") } });
    const result = await rescreen(shared, lookup, { batchSize: 10 });
    expect(calls).toEqual([["OFAC-1"]]);
    expect(result.reopen).toHaveLength(3);
  });

  it("handles an empty portfolio and keeps the run's configuration snapshot", async () => {
    const { lookup, calls } = lookupOf({});
    const result = await rescreen([], lookup);
    expect(result).toMatchObject({ total: 0, examined: 0, complete: true, nextCursor: null, reopen: [], release: [] });
    expect(calls).toEqual([]);
    expect(result.chunkConfig.maxChunks).toBe(32);
  });

  it("uses the default batch size and rejects a batch limit outside the engine's bounds", async () => {
    const many = Array.from({ length: 120 }, (_, i) => disposition(i + 1));
    const { lookup, calls } = lookupOf({});
    const result = await rescreen(many, lookup);
    expect(result.batches).toBe(3);
    expect(calls.map((c) => c.length)).toEqual([50, 50, 20]);
    await expect(rescreen(many, lookup, { maxBatches: 99 })).rejects.toThrow(/outside/);
  });
});

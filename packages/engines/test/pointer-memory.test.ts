import { type CurrentRow, type DispositionMemory, hashRow, type MemoryPointer } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { PointerMemory, type RowLookup } from "../src/domain/pointer-memory.js";

const sha = (c: string) => c.repeat(64);
const ROW = { entry_id: "OFAC-1", primary_name: "Some Listed Name" };
const HASH = hashRow(ROW);
const TABLE = "lightning.metastore.sanctions.screening_usl.list_entry";

function memory(over: Partial<DispositionMemory> = {}, pointer: Partial<MemoryPointer> = {}): DispositionMemory {
  return {
    memory_id: "mem-in",
    alert_type: "customer",
    decision: "CLOSE_FALSE_POSITIVE",
    reason_codes: ["DOB_CONFLICT", "NATIONALITY_DIFFERS"],
    pointers: [
      {
        usl_table: TABLE,
        row_key: { entry_id: "OFAC-1" },
        content_hash: HASH,
        list_snapshot_id: "ofac-2026-10-21",
        captured_at: "2026-10-22T10:00:00.000Z",
        ...pointer,
      },
    ],
    policy: { version: 1, hash: sha("a") },
    decision_record_hash: sha("b"),
    created_at: "2026-10-22T10:00:00.000Z",
    ...over,
  };
}

function setup(current: CurrentRow | undefined = { content_hash: HASH, list_snapshot_id: "ofac-2026-10-21" }) {
  const state: { current: CurrentRow | undefined } = { current };
  const lookup: RowLookup = () => state.current;
  const pm = new PointerMemory({ lookup, clock: () => 1_750_000_000_000 });
  return { pm, state };
}

describe("remember and recall", () => {
  it("keeps codes and tags in memory, never row contents or names", () => {
    const { pm } = setup();
    const record = pm.remember(memory());
    expect(record.content).toBe("Past customer decision CLOSE_FALSE_POSITIVE: DOB_CONFLICT, NATIONALITY_DIFFERS");
    expect(record.tags).toContain(`key:${TABLE}:entry_id=OFAC-1`);
    expect(JSON.stringify(record)).not.toContain("Some Listed Name");
    expect(record.source).toBe(`decision-record:${sha("b")}`);
    expect(pm.size()).toBe(1);
  });

  it("uses a memory whose pointers are all fresh", async () => {
    const { pm } = setup();
    pm.remember(memory());
    const [recalled] = await pm.recall(TABLE, { entry_id: "OFAC-1" });
    expect(recalled).toMatchObject({ pointerStates: ["fresh"], usable: true, reopen: false, overridden: false });
    expect(recalled?.memory.decision).toBe("CLOSE_FALSE_POSITIVE");
  });

  it("returns nothing for a different row or table", async () => {
    const { pm } = setup();
    pm.remember(memory());
    expect(await pm.recall(TABLE, { entry_id: "OFAC-2" })).toEqual([]);
    expect(await pm.recall("other.table", { entry_id: "OFAC-1" })).toEqual([]);
  });

  it("matches a multi-column key whatever the column order", async () => {
    const { pm } = setup();
    pm.remember(memory({}, { row_key: { b: "2", a: "1" } }));
    expect(await pm.recall(TABLE, { a: "1", b: "2" })).toHaveLength(1);
  });
});

describe("pointers that no longer hold", () => {
  it("marks a memory stale when the row content changed (a tampered or updated hash)", async () => {
    const { pm, state } = setup();
    const record = pm.remember(memory());
    state.current = { content_hash: hashRow({ ...ROW, primary_name: "Changed" }), list_snapshot_id: "ofac-2026-10-21" };
    const [recalled] = await pm.recall(TABLE, { entry_id: "OFAC-1" });
    expect(recalled).toMatchObject({ pointerStates: ["stale"], usable: false, reopen: true });
    expect(pm.hmem.store.get(record.id)?.tags).toContain("stale");
    await pm.recall(TABLE, { entry_id: "OFAC-1" });
    expect(pm.hmem.store.get(record.id)?.tags.filter((t) => t === "stale")).toHaveLength(1);
  });

  it("marks a memory stale when the list snapshot moved on, even with the same hash", async () => {
    const { pm, state } = setup();
    pm.remember(memory());
    state.current = { content_hash: HASH, list_snapshot_id: "ofac-2026-10-29" };
    expect((await pm.recall(TABLE, { entry_id: "OFAC-1" }))[0]).toMatchObject({
      pointerStates: ["stale"],
      usable: false,
    });
  });

  it("marks a memory missing when the row is gone", async () => {
    const { pm, state } = setup();
    pm.remember(memory());
    state.current = undefined;
    expect((await pm.recall(TABLE, { entry_id: "OFAC-1" }))[0]).toMatchObject({
      pointerStates: ["missing"],
      usable: false,
      reopen: true,
    });
  });

  it("needs every pointer fresh", async () => {
    const second: MemoryPointer = {
      usl_table: "t.customer",
      row_key: { customer_id: "C1" },
      content_hash: sha("c"),
      captured_at: "2026-10-22T10:00:00.000Z",
    };
    const calls: string[] = [];
    const pm = new PointerMemory({
      lookup: (p) => {
        calls.push(p.usl_table);
        return p.usl_table === TABLE
          ? { content_hash: HASH, list_snapshot_id: "ofac-2026-10-21" }
          : { content_hash: sha("d") };
      },
    });
    const base = memory();
    pm.remember({ ...base, pointers: [...base.pointers, second] });
    const [recalled] = await pm.recall(TABLE, { entry_id: "OFAC-1" });
    expect(recalled?.pointerStates).toEqual(["fresh", "stale"]);
    expect(recalled?.usable).toBe(false);
    expect(calls).toEqual([TABLE, "t.customer"]);
  });
});

describe("human override", () => {
  it("beats memory, is written to the ledger and survives a fresh pointer", async () => {
    const { pm } = setup();
    const record = pm.remember(memory());
    const entry = pm.override({ memoryId: record.id, actor: "alice@example.test", reason: "new evidence from KYC" });
    expect(entry).toMatchObject({
      action: "conflict_resolved",
      actor: "alice@example.test",
      details: { winner: "human_override", reason: "new evidence from KYC" },
    });
    const [recalled] = await pm.recall(TABLE, { entry_id: "OFAC-1" });
    expect(recalled).toMatchObject({ pointerStates: ["fresh"], usable: false, overridden: true });
    expect(pm.history(record.id).map((e) => e.action)).toEqual(["create", "update", "conflict_resolved"]);
    expect(pm.hmem.store.get(record.id)?.supersededBy).toBe("override:alice@example.test");
  });

  it("needs a known memory and a reason", () => {
    const { pm } = setup();
    const record = pm.remember(memory());
    expect(() => pm.override({ memoryId: "mem-99", actor: "a", reason: "r" })).toThrow(/unknown memory/);
    expect(() => pm.override({ memoryId: record.id, actor: "a", reason: "  " })).toThrow(/needs a reason/);
  });
});

describe("validation", () => {
  it("rejects a memory with no reason codes, a bad hash or a duplicate", () => {
    const { pm } = setup();
    expect(() => pm.remember(memory({ reason_codes: [] }))).toThrow();
    expect(() => pm.remember(memory({}, { content_hash: "not-a-hash" }))).toThrow();
    expect(() => pm.remember(memory({ reason_codes: ["lower case"] }))).toThrow();
    expect(() => pm.remember(memory({ pointers: [] }))).toThrow();
  });

  it("ignores a memory marked as superseded in its own body", async () => {
    const { pm } = setup();
    pm.remember(memory({ superseded_by: "mem-other" }));
    expect((await pm.recall(TABLE, { entry_id: "OFAC-1" }))[0]?.usable).toBe(false);
  });
});

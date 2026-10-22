import { describe, expect, it } from "vitest";
import { applyDelta, DeltaOpSchema } from "../src/index.js";
import { first, ofacFixtureSnapshot } from "./helpers.js";

describe("synthetic delta", () => {
  it("marks the result as synthetic, with a new id that names its base", () => {
    const base = ofacFixtureSnapshot();
    const next = applyDelta(base, [{ op: "add_program", entry_id: "OFAC-1001", program: "TEST" }], "demo update");
    expect(next.meta.synthetic).toEqual({ label: "demo update", base_snapshot_id: base.meta.snapshot_id });
    expect(next.meta.snapshot_id).toMatch(/^ofac-sdn-2026-10-21-aaaaaaaa\+synthetic-[a-f0-9]{8}$/);
    expect(next.meta.raw_file).toBe("synthetic-delta");
    expect(next.tables.list_entry.every((e) => e.snapshot_id === next.meta.snapshot_id)).toBe(true);
    expect(next.meta.counts.list_program).toBe(base.tables.list_program.length + 1);
  });

  it("leaves the base snapshot untouched and gives changed entries a new hash", () => {
    const base = ofacFixtureSnapshot();
    const baseHash = first(base.tables.list_entry).content_hash;
    const next = applyDelta(base, [{ op: "add_alias", entry_id: "OFAC-1001", alias_name: "New Alias" }], "demo");
    expect(first(base.tables.list_entry).content_hash).toBe(baseHash);
    expect(first(next.tables.list_entry).content_hash).not.toBe(baseHash);
    expect(next.tables.list_entry[1]?.content_hash).toBe(base.tables.list_entry[1]?.content_hash);
  });

  it("gives the same id for the same label and edits, and a different one otherwise", () => {
    const base = ofacFixtureSnapshot();
    const ops = [{ op: "add_program" as const, entry_id: "OFAC-1001", program: "TEST" }];
    expect(applyDelta(base, ops, "a").meta.snapshot_id).toBe(applyDelta(base, ops, "a").meta.snapshot_id);
    expect(applyDelta(base, ops, "a").meta.snapshot_id).not.toBe(applyDelta(base, ops, "b").meta.snapshot_id);
  });

  it("removes an entry together with everything that belongs to it", () => {
    const next = applyDelta(ofacFixtureSnapshot(), [{ op: "remove_entry", entry_id: "OFAC-1001" }], "delist");
    const tables = next.tables;
    expect(tables.list_entry.map((e) => e.entry_id)).not.toContain("OFAC-1001");
    for (const rows of [
      tables.list_alias,
      tables.list_dob,
      tables.list_country,
      tables.list_identifier,
      tables.list_program,
    ]) {
      expect(rows.some((r) => r.entry_id === "OFAC-1001")).toBe(false);
    }
    expect(tables.list_relationship).toEqual([]);
  });

  it("rejects unknown entries, bad dates, empty labels and unknown operations", () => {
    const base = ofacFixtureSnapshot();
    expect(() => applyDelta(base, [{ op: "remove_entry", entry_id: "OFAC-404" }], "x")).toThrow(/unknown entry/);
    expect(() => applyDelta(base, [{ op: "replace_dobs", entry_id: "OFAC-1001", dob_value: "1971-13" }], "x")).toThrow(
      /not a valid partial date/,
    );
    expect(() => applyDelta(base, [{ op: "remove_entry", entry_id: "OFAC-1001" }], "  ")).toThrow(/needs a label/);
    expect(DeltaOpSchema.safeParse({ op: "explode", entry_id: "x" }).success).toBe(false);
  });

  it("renames an entry and refreshes the normalised name", () => {
    const next = applyDelta(
      ofacFixtureSnapshot(),
      [{ op: "rename", entry_id: "OFAC-1001", primary_name: "Иван Петров" }],
      "rename",
    );
    expect(first(next.tables.list_entry)).toMatchObject({
      primary_name: "Иван Петров",
      name_normalised: "иван петров",
      primary_name_script: "Cyrillic",
    });
  });
});

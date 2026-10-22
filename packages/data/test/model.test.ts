import { describe, expect, it } from "vitest";
import {
  computeContentHashes,
  emptyTables,
  ListEntryRowSchema,
  sealEntries,
  shortHash,
  TABLE_COLUMNS,
  TABLE_NAMES,
  TABLES,
  type TableRows,
} from "../src/model.js";
import { first } from "./helpers.js";

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  entry_id: id,
  list_id: "OFAC" as const,
  source_uid: id.replace("OFAC-", ""),
  party_kind: "individual" as const,
  primary_name: "Example Person",
  primary_name_script: "Latin",
  name_normalised: "example person",
  listed_on: "2020-01-02",
  sanctions_list: "SDN List",
  remarks: null,
  snapshot_id: "snap-1",
  content_hash: "0".repeat(64),
  ...over,
});

function tables(): TableRows {
  const t = emptyTables();
  t.list_entry.push(entry("OFAC-1"), entry("OFAC-2", { primary_name: "Other Person" }));
  t.list_alias.push({
    alias_id: "a1",
    entry_id: "OFAC-1",
    alias_name: "E. Person",
    alias_type: "aka",
    script: "Latin",
    name_normalised: "e person",
    is_primary: false,
    is_strong: true,
  });
  t.list_dob.push({
    dob_id: "d1",
    entry_id: "OFAC-1",
    dob_value: "1971",
    precision: "year",
    range_from: null,
    range_to: null,
    is_approximate: false,
  });
  t.list_relationship.push({
    relationship_id: "r1",
    from_entry_id: "OFAC-2",
    to_entry_id: "OFAC-1",
    relation_type: "owned_or_controlled_by",
    is_former: false,
  });
  return t;
}

describe("table model", () => {
  it("has a schema and a column list for every table, in agreement", () => {
    expect(TABLE_NAMES).toEqual(Object.keys(TABLE_COLUMNS));
    for (const name of TABLE_NAMES) {
      const schemaKeys = Object.keys((TABLES[name] as unknown as { shape: Record<string, unknown> }).shape).sort();
      expect([...TABLE_COLUMNS[name]].sort()).toEqual(schemaKeys);
    }
  });

  it("rejects rows with unknown columns or bad values", () => {
    expect(ListEntryRowSchema.safeParse(entry("OFAC-1")).success).toBe(true);
    expect(ListEntryRowSchema.safeParse({ ...entry("OFAC-1"), extra: 1 }).success).toBe(false);
    expect(ListEntryRowSchema.safeParse(entry("OFAC-1", { party_kind: "robot" })).success).toBe(false);
    expect(ListEntryRowSchema.safeParse(entry("OFAC-1", { listed_on: "yesterday" })).success).toBe(false);
  });

  it("makes short stable id fragments", () => {
    expect(shortHash("a", "b")).toMatch(/^[a-f0-9]{8}$/);
    expect(shortHash("a", "b")).toBe(shortHash("a", "b"));
    expect(shortHash("a", "b")).not.toBe(shortHash("ab", ""));
  });
});

describe("content hashes", () => {
  it("gives every entry a hash that ignores row ids, order and the snapshot id", () => {
    const a = computeContentHashes(tables());
    const t = tables();
    t.list_entry.forEach((e) => {
      e.snapshot_id = "snap-2";
    });
    t.list_alias.forEach((r) => {
      r.alias_id = `${r.alias_id}-renamed`;
    });
    t.list_entry.reverse();
    const b = computeContentHashes(t);
    expect(b.get("OFAC-1")).toBe(a.get("OFAC-1"));
    expect(b.get("OFAC-2")).toBe(a.get("OFAC-2"));
    expect(a.get("OFAC-1")).not.toBe(a.get("OFAC-2"));
  });

  it("changes when anything about the entry changes", () => {
    const base = computeContentHashes(tables()).get("OFAC-1");
    const withAlias = tables();
    withAlias.list_alias.push({
      ...first(withAlias.list_alias),
      alias_id: "a2",
      alias_name: "New Alias",
      name_normalised: "new alias",
    });
    expect(computeContentHashes(withAlias).get("OFAC-1")).not.toBe(base);

    const withDob = tables();
    first(withDob.list_dob).dob_value = "1972";
    expect(computeContentHashes(withDob).get("OFAC-1")).not.toBe(base);

    const renamed = tables();
    first(renamed.list_entry).primary_name = "Renamed";
    expect(computeContentHashes(renamed).get("OFAC-1")).not.toBe(base);
  });

  it("covers relationships from the entry, and seals hashes into the entries", () => {
    const t = tables();
    const before = computeContentHashes(t).get("OFAC-2");
    first(t.list_relationship).is_former = true;
    expect(computeContentHashes(t).get("OFAC-2")).not.toBe(before);

    sealEntries(t);
    expect(t.list_entry.every((e) => /^[a-f0-9]{64}$/.test(e.content_hash) && e.content_hash !== "0".repeat(64))).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import { affectedEntryIds, applyDelta, diffSnapshots, SnapshotDeltaSchema, sealEntries } from "../src/index.js";
import { first, ofacFixtureSnapshot } from "./helpers.js";

describe("snapshot diff", () => {
  it("reports no changes between identical snapshots", () => {
    const a = ofacFixtureSnapshot();
    const delta = diffSnapshots(a, ofacFixtureSnapshot());
    expect(delta.summary).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 4 });
    expect(affectedEntryIds(delta)).toEqual([]);
    expect(SnapshotDeltaSchema.safeParse(delta).success).toBe(true);
  });

  it("finds added, removed and changed entries", () => {
    const before = ofacFixtureSnapshot();
    const after = applyDelta(
      before,
      [
        { op: "remove_entry", entry_id: "OFAC-1003" },
        { op: "add_alias", entry_id: "OFAC-1001", alias_name: "Ivan P. Petrov" },
      ],
      "test delta",
    );
    const delta = diffSnapshots(before, after);
    expect(delta.summary).toMatchObject({ added: 0, removed: 1, changed: 1, unchanged: 2 });
    expect(delta.removed.map((e) => e.entry_id)).toEqual(["OFAC-1003"]);
    expect(first(delta.changed).entry_id).toBe("OFAC-1001");
    expect(delta.synthetic).toEqual({ label: "test delta" });

    const reverse = diffSnapshots(after, before);
    expect(reverse.added.map((e) => e.entry_id)).toEqual(["OFAC-1003"]);
  });

  it("describes what changed inside an entry", () => {
    const before = ofacFixtureSnapshot();
    const after = applyDelta(
      before,
      [
        { op: "add_alias", entry_id: "OFAC-1001", alias_name: "Ivan P. Petrov" },
        { op: "replace_dobs", entry_id: "OFAC-1001", dob_value: "1975-04-05" },
        {
          op: "add_identifier",
          entry_id: "OFAC-1001",
          id_type: "passport",
          id_number: "Z9999999",
          issuing_country: "RU",
        },
        { op: "add_program", entry_id: "OFAC-1001", program: "UKRAINE-EO13660" },
        { op: "rename", entry_id: "OFAC-1002", primary_name: "PETROV GROUP LLC" },
      ],
      "test delta",
    );
    const changes = Object.fromEntries(diffSnapshots(before, after).changed.map((c) => [c.entry_id, c.changes]));
    const person = changes["OFAC-1001"] ?? [];
    const field = (name: string) => person.find((c) => c.field === name);
    expect(field("aliases")).toMatchObject({ added: ["aka: Ivan P. Petrov"], removed: [] });
    expect(field("dobs")).toMatchObject({ added: ["1975-04-05"], removed: ["1971", "1972-03-02 (approximate)"] });
    expect(field("identifiers")).toMatchObject({ added: ["passport: Z9999999 (RU)"] });
    expect(field("programs")).toMatchObject({ added: ["UKRAINE-EO13660"] });
    expect(changes["OFAC-1002"]).toEqual([
      { field: "primary_name", before: "PETROV TRADING LLC", after: "PETROV GROUP LLC" },
    ]);
  });

  it("treats a removed target as a change to the relationships of the owner", () => {
    const before = ofacFixtureSnapshot();
    const after = applyDelta(before, [{ op: "remove_entry", entry_id: "OFAC-1001" }], "owner delisted");
    const delta = diffSnapshots(before, after);
    expect(delta.removed.map((e) => e.entry_id)).toEqual(["OFAC-1001"]);
    const owner = delta.changed.find((c) => c.entry_id === "OFAC-1002");
    expect(owner?.changes).toEqual([
      { field: "relationships", added: [], removed: ["owned_or_controlled_by -> OFAC-1001"] },
    ]);
    expect(affectedEntryIds(delta)).toEqual(["OFAC-1001", "OFAC-1002"]);
  });

  it("does not count a change to remarks alone as affecting screening", () => {
    const before = ofacFixtureSnapshot();
    const after = structuredClone(before);
    first(after.tables.list_entry).remarks = "A new note";
    sealEntries(after.tables);
    const delta = diffSnapshots(before, after);
    expect(delta.summary.changed).toBe(1);
    expect(first(delta.changed).changes).toEqual([
      { field: "remarks", before: "Fictional test person with a year-only birth date.", after: "A new note" },
    ]);
    expect(affectedEntryIds(delta)).toEqual([]);
  });
});

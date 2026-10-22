import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DataSource,
  type FetchedFile,
  normaliseRaw,
  readSnapshot,
  snapshotIdFor,
  TABLE_COLUMNS,
  TABLE_NAMES,
  toCsv,
  writeSnapshot,
} from "../src/index.js";
import { first, fixturePath, ofacFixtureSnapshot, tempDir } from "./helpers.js";

describe("snapshot ids", () => {
  it("combine the source, the issue date and the start of the file hash", () => {
    expect(snapshotIdFor("ofac-sdn", "2026-10-21", "abcdef0123456789".repeat(4))).toBe("ofac-sdn-2026-10-21-abcdef01");
    expect(snapshotIdFor("un-consolidated", null, "0123456789abcdef".repeat(4))).toBe(
      "un-consolidated-undated-01234567",
    );
  });
});

describe("normaliseRaw", () => {
  const source: DataSource = {
    id: "ofac-sdn",
    list: "OFAC",
    sanctionsList: "SDN List",
    format: "ofac-advanced",
    url: "https://example.test/SDN_ADVANCED.XML",
    file: "SDN_ADVANCED.XML",
  };
  const raw: FetchedFile = {
    source_id: "ofac-sdn",
    url: source.url,
    file: source.file,
    fetched_at: "2026-10-23T01:02:03.000Z",
    sha256: "f".repeat(64),
    bytes: 4242,
    path: fixturePath("ofac-mini.xml"),
    reused: false,
  };

  it("parses a raw file into a sealed snapshot with full metadata", async () => {
    const snapshot = await normaliseRaw(source, raw);
    expect(snapshot.meta).toMatchObject({
      snapshot_id: "ofac-sdn-2026-10-21-ffffffff",
      source_id: "ofac-sdn",
      list_id: "OFAC",
      issued_on: "2026-10-21",
      raw_sha256: "f".repeat(64),
      raw_bytes: 4242,
      counts: { list_entry: 4, list_relationship: 1 },
    });
    expect(snapshot.tables.list_entry.every((e) => e.snapshot_id === snapshot.meta.snapshot_id)).toBe(true);
    expect(
      snapshot.tables.list_entry.every(
        (e) => /^[a-f0-9]{64}$/.test(e.content_hash) && e.content_hash !== "0".repeat(64),
      ),
    ).toBe(true);
  });

  it("parses the UN format too", async () => {
    const un: DataSource = {
      ...source,
      id: "un-consolidated",
      list: "UN",
      format: "un-consolidated",
      sanctionsList: "UN list",
      file: "consolidated.xml",
    };
    const snapshot = await normaliseRaw(un, { ...raw, source_id: "un-consolidated", path: fixturePath("un-mini.xml") });
    expect(snapshot.meta.list_id).toBe("UN");
    expect(snapshot.tables.list_entry).toHaveLength(3);
  });
});

describe("CSV output", () => {
  it("writes a header, quotes awkward values, and writes booleans and nulls plainly", () => {
    const csv = toCsv("list_program", [
      { program_id: "p1", entry_id: "e1", program: "plain" },
      { program_id: "p2", entry_id: "e1", program: "has, comma" },
      { program_id: "p3", entry_id: "e1", program: 'has "quote"' },
      { program_id: "p4", entry_id: "e1", program: "two\nlines" },
    ]);
    expect(csv.split("\n")[0]).toBe("program_id,entry_id,program");
    expect(csv).toContain('p2,e1,"has, comma"');
    expect(csv).toContain('p3,e1,"has ""quote"""');
    expect(csv).toContain('p4,e1,"two\nlines"');

    const alias = toCsv("list_alias", [
      {
        alias_id: "a",
        entry_id: "e",
        alias_name: "N",
        alias_type: "aka",
        script: "Latin",
        name_normalised: "n",
        is_primary: false,
        is_strong: true,
      },
    ]);
    expect(alias.split("\n")[1]).toBe("a,e,N,aka,Latin,n,false,true");
    const dob = toCsv("list_dob", [
      {
        dob_id: "d",
        entry_id: "e",
        dob_value: null,
        precision: "range",
        range_from: "1950-01-01",
        range_to: "1953-12-31",
        is_approximate: false,
      },
    ]);
    expect(dob.split("\n")[1]).toBe("d,e,,range,1950-01-01,1953-12-31,false");
  });
});

describe("writing and reading snapshots", () => {
  it("writes JSON arrays, CSV files and metadata for every table, and reads them back identically", () => {
    const snapshot = ofacFixtureSnapshot();
    const dir = join(tempDir(), "snap");
    writeSnapshot(dir, snapshot);
    for (const name of TABLE_NAMES) {
      expect(existsSync(join(dir, `${name}.json`)), name).toBe(true);
      expect(readFileSync(join(dir, `${name}.csv`), "utf8").split("\n")[0]).toBe(TABLE_COLUMNS[name].join(","));
      expect(Array.isArray(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")))).toBe(true);
    }
    const back = readSnapshot(dir);
    expect(back.meta).toEqual(snapshot.meta);
    for (const name of TABLE_NAMES) expect(back.tables[name].length).toBe(snapshot.tables[name].length);
    expect(first(back.tables.list_entry).entry_id).toBe("OFAC-1001");
  });

  it("writes rows sorted by their first column, so output is stable", () => {
    const dir = join(tempDir(), "snap");
    const snapshot = ofacFixtureSnapshot();
    snapshot.tables.list_entry.reverse();
    writeSnapshot(dir, snapshot);
    const ids = JSON.parse(readFileSync(join(dir, "list_entry.json"), "utf8")).map(
      (e: { entry_id: string }) => e.entry_id,
    );
    expect(ids).toEqual([...ids].sort());
  });

  it("reports a missing snapshot and refuses rows that break the schema", () => {
    expect(() => readSnapshot(join(tempDir(), "nothing"))).toThrow(/no snapshot found/);
    const dir = join(tempDir(), "snap");
    writeSnapshot(dir, ofacFixtureSnapshot());
    const rows = JSON.parse(readFileSync(join(dir, "list_entry.json"), "utf8"));
    rows[0].party_kind = "robot";
    writeFileSync(join(dir, "list_entry.json"), JSON.stringify(rows));
    expect(() => readSnapshot(dir)).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countryOfLocation, parseOfacFile, parseOfacString } from "../src/ofac.js";
import { first } from "./helpers.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/ofac-mini.xml", import.meta.url));
const options = { snapshotId: "ofac-sdn-2026-10-21-test", sanctionsList: "SDN List" };
const parse = () => parseOfacString(readFileSync(FIXTURE, "utf8"), options);

const byEntry = <T extends { entry_id: string }>(rows: T[], id: string): T[] => rows.filter((r) => r.entry_id === id);

describe("OFAC advanced XML parser", () => {
  it("lists only parties that have a sanctions entry, and reports the rest", () => {
    const { tables, stats, issuedOn } = parse();
    expect(tables.list_entry.map((e) => e.entry_id)).toEqual(["OFAC-1001", "OFAC-1002", "OFAC-1003", "OFAC-1005"]);
    expect(stats).toMatchObject({ parties: 5, entries: 4, skippedParties: 1 });
    expect(issuedOn).toBe("2026-10-21");
  });

  it("builds the entry row: kind, name in natural order, earliest listing date, list name, remarks", () => {
    const entries = parse().tables.list_entry;
    const person = first(entries);
    expect(person).toMatchObject({
      entry_id: "OFAC-1001",
      list_id: "OFAC",
      source_uid: "1001",
      party_kind: "individual",
      primary_name: "Ivan Ivanovich PETROV",
      primary_name_script: "Latin",
      name_normalised: "ivan ivanovich petrov",
      listed_on: "2021-06-15",
      sanctions_list: "SDN List",
      remarks: "Fictional test person with a year-only birth date.",
      snapshot_id: "ofac-sdn-2026-10-21-test",
    });
    expect(entries.map((e) => [e.entry_id, e.party_kind, e.sanctions_list])).toEqual([
      ["OFAC-1001", "individual", "SDN List"],
      ["OFAC-1002", "entity", "SDN List"],
      ["OFAC-1003", "vessel", "Consolidated List"],
      ["OFAC-1005", "individual", "SDN List"],
    ]);
  });

  it("keeps aliases in every script with their type and strength", () => {
    const aliases = byEntry(parse().tables.list_alias, "OFAC-1001");
    const summary = aliases.map((a) => [a.alias_name, a.alias_type, a.script, a.is_primary, a.is_strong]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ["Ivan Ivanovich PETROV", "primary", "Latin", true, true],
        ["ПЕТРОВ Иван Иванович", "aka", "Cyrillic", false, true],
        ["Vanya P", "low_quality", "Latin", false, false],
        ["Ivan Petrovich", "fka", "Latin", false, true],
      ]),
    );
    expect(aliases).toHaveLength(4);
    expect(new Set(aliases.map((a) => a.alias_id)).size).toBe(4);
    expect(aliases.find((a) => a.script === "Cyrillic")?.name_normalised).toBe("петров иван иванович");
  });

  it("reads every script spelling of one alias as its own row", () => {
    const aliases = byEntry(parse().tables.list_alias, "OFAC-1005");
    expect(aliases.map((a) => [a.alias_name, a.alias_type, a.script, a.is_primary]).sort()).toEqual([
      ["Muhammad AL-TEST", "primary", "Latin", true],
      ["محمد التست", "primary", "Arabic", false],
    ]);
    expect(first(parse().tables.list_entry.filter((e) => e.entry_id === "OFAC-1005")).primary_name).toBe(
      "Muhammad AL-TEST",
    );
  });

  it("reads partial and approximate dates of birth", () => {
    const dobs = byEntry(parse().tables.list_dob, "OFAC-1001");
    expect(dobs.map((d) => [d.dob_value, d.dob_precision, d.is_approximate]).sort()).toEqual([
      ["1971", "year", false],
      ["1972-03-02", "day", true],
    ]);
  });

  it("reads places and countries with their role, and skips postal codes", () => {
    const { tables, stats } = parse();
    const person = byEntry(tables.list_country, "OFAC-1001").map((c) => [c.role, c.country_iso2, c.place]);
    expect(person).toEqual(
      expect.arrayContaining([
        ["place_of_birth", null, "Leningrad"],
        ["nationality", "RU", null],
        ["address", "RU", "Moscow, 1 Test Street"],
      ]),
    );
    expect(person.some((p) => String(p[2]).includes("101000"))).toBe(false);
    const entity = byEntry(tables.list_country, "OFAC-1002");
    expect(entity.find((c) => c.role === "registered_in")).toMatchObject({
      country_iso2: "AE",
      country_name: "United Arab Emirates",
    });
    // A code that is not an ISO country is kept as a name only, and counted.
    expect(entity.find((c) => c.role === "address")).toMatchObject({ country_iso2: null, country_name: "Nowhere" });
    expect(stats.unmappedCountries).toBe(1);
  });

  it("maps identity documents and notes fraudulent ones, ignoring empty numbers", () => {
    const ids = parse().tables.list_identifier;
    expect(byEntry(ids, "OFAC-1001").map((i) => [i.id_type, i.id_number, i.issuing_country])).toEqual([
      ["passport", "P1234567", "RU"],
    ]);
    const entity = byEntry(ids, "OFAC-1002");
    expect(entity.map((i) => [i.id_type, i.id_number]).sort()).toEqual([
      ["registration", "REG-42"],
      ["swift_bic", "PETRRUMM"],
      ["tax_id", "7700000001"],
    ]);
    expect(entity.find((i) => i.id_number === "REG-42")?.note).toContain("fraudulent");
    expect(byEntry(ids, "OFAC-1003")).toEqual([
      expect.objectContaining({ id_type: "vessel_imo", id_number: "CALL123" }),
    ]);
  });

  it("takes programs from the sanctions measures that name one", () => {
    const programs = parse().tables.list_program;
    expect(
      byEntry(programs, "OFAC-1001")
        .map((p) => p.program)
        .sort(),
    ).toEqual(["RUSSIA-EO14024", "SDGT"]);
    expect(byEntry(programs, "OFAC-1002").map((p) => p.program)).toEqual(["IRAN"]);
  });

  it("keeps ownership links between listed parties and drops links to unlisted ones", () => {
    const rels = parse().tables.list_relationship;
    expect(rels).toEqual([
      {
        relationship_id: "OFAC-rel-6001",
        from_entry_id: "OFAC-1002",
        to_entry_id: "OFAC-1001",
        relation_type: "owned_or_controlled_by",
        is_former: false,
      },
    ]);
  });

  it("counts the features it chose to ignore", () => {
    expect(parse().stats.ignoredFeatures).toEqual({ Gender: 1 });
  });

  it("uses the id prefix so two files share one id space", () => {
    const { tables } = parseOfacString(readFileSync(FIXTURE, "utf8"), { ...options, idPrefix: "X" });
    expect(first(tables.list_entry).entry_id).toBe("X-1001");
    expect(first(tables.list_relationship).to_entry_id).toBe("X-1001");
  });

  it("produces identical output for identical input, and reads the same from a file", async () => {
    const a = parse();
    const b = parse();
    expect(JSON.stringify(a.tables)).toBe(JSON.stringify(b.tables));
    const fromFile = await parseOfacFile(FIXTURE, options);
    expect(JSON.stringify(fromFile.tables)).toBe(JSON.stringify(a.tables));
  });

  it("rejects input that is not XML", () => {
    expect(() => parseOfacString("not xml at all", options)).toThrow();
    expect(() => parseOfacString("", options)).toThrow(/XML parse error/);
  });
});

describe("countryOfLocation", () => {
  const loc = (over: Partial<{ countryIso2: string | null; countryName: string | null; place: string | null }>) =>
    ({ countryIso2: null, countryName: null, place: null, ...over }) as Parameters<typeof countryOfLocation>[0];
  it("uses the code when there is one, else resolves a country name", () => {
    expect(countryOfLocation(loc({ countryIso2: "BE", place: "Elsewhere" }))).toBe("BE");
    expect(countryOfLocation(loc({ place: "Kuwait" }))).toBe("KW");
    expect(countryOfLocation(loc({ countryName: "United Kingdom" }))).toBe("GB");
  });
  it("reads the country at the end of a city and country place", () => {
    expect(countryOfLocation(loc({ place: "Baghdad, Iraq" }))).toBe("IQ");
  });
  it("gives null when nothing names a country", () => {
    expect(countryOfLocation(loc({ place: "Somewhere unknown" }))).toBeNull();
    expect(countryOfLocation(loc({}))).toBeNull();
  });
});

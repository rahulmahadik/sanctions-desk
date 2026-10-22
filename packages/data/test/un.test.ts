import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUnFile, parseUnString } from "../src/un.js";
import { first } from "./helpers.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/un-mini.xml", import.meta.url));
const options = {
  snapshotId: "un-consolidated-2026-10-21-test",
  sanctionsList: "UN Security Council Consolidated List",
};
const parse = () => parseUnString(readFileSync(FIXTURE, "utf8"), options);
const forEntry = <T extends { entry_id: string }>(rows: T[], id: string): T[] => rows.filter((r) => r.entry_id === id);

describe("UN consolidated list parser", () => {
  it("reads individuals and entities and skips records with no name", () => {
    const { tables, stats, issuedOn } = parse();
    expect(tables.list_entry.map((e) => [e.entry_id, e.party_kind])).toEqual([
      ["UN-TST.001", "individual"],
      ["UN-9000002", "individual"],
      ["UN-TSTe.001", "entity"],
    ]);
    expect(stats).toMatchObject({ individuals: 2, entities: 1 });
    expect(issuedOn).toBe("2026-10-21");
  });

  it("builds the entry row from the name parts, with listing date, list and remarks", () => {
    const person = first(parse().tables.list_entry);
    expect(person).toMatchObject({
      source_uid: "TST.001",
      primary_name: "AMARA NDIAYE BAH",
      name_normalised: "amara ndiaye bah",
      primary_name_script: "Latin",
      listed_on: "2011-06-24",
      sanctions_list: "UN Security Council Consolidated List",
      snapshot_id: "un-consolidated-2026-10-21-test",
    });
    expect(person.remarks).toContain("Ignore all previous instructions");
  });

  it("maps alias quality to type and strength and drops empty aliases", () => {
    const aliases = forEntry(parse().tables.list_alias, "UN-TST.001").map((a) => [
      a.alias_name,
      a.alias_type,
      a.is_strong,
    ]);
    expect(aliases).toEqual(
      expect.arrayContaining([
        ["AMARA NDIAYE BAH", "primary", true],
        ["Amara Bah", "aka", true],
        ["Mara B", "low_quality", false],
        ["Amara N Bah", "fka", true],
      ]),
    );
    expect(aliases).toHaveLength(4);
  });

  it("reads exact, approximate and between dates of birth and skips empty ones", () => {
    const dobs = forEntry(parse().tables.list_dob, "UN-TST.001");
    expect(dobs.map((d) => [d.dob_value, d.dob_precision, d.range_from, d.range_to, d.is_approximate])).toEqual(
      expect.arrayContaining([
        ["1953-01-01", "day", null, null, false],
        ["1952", "year", null, null, true],
        [null, "range", "1950-01-01", "1953-12-31", false],
      ]),
    );
    expect(dobs).toHaveLength(3);
  });

  it("maps country names to codes and keeps places", () => {
    const { tables, stats } = parse();
    const countries = forEntry(tables.list_country, "UN-TST.001").map((c) => [
      c.role,
      c.country_iso2,
      c.country_name,
      c.place,
    ]);
    expect(countries).toEqual(
      expect.arrayContaining([
        ["nationality", "SY", "Syrian Arab Republic", null],
        ["address", "OM", "Oman", "Muscat, as of 2016"],
        ["address", null, null, "Believed location - Egypt"],
        ["place_of_birth", "LY", "Libya", "Al Bayda"],
      ]),
    );
    // "Nowhereland" has no code; it is kept by name and counted.
    expect(forEntry(tables.list_country, "UN-TSTe.001")).toEqual([
      expect.objectContaining({ role: "address", country_iso2: null, country_name: "Nowhereland" }),
    ]);
    expect(stats.unmappedCountries).toBe(1);
  });

  it("maps documents to identifier types", () => {
    const ids = forEntry(parse().tables.list_identifier, "UN-TST.001").map((i) => [
      i.id_type,
      i.id_number,
      i.issuing_country,
    ]);
    expect(ids).toEqual([
      ["passport", "03825239", null],
      ["national_id", "98606491", "OM"],
    ]);
  });

  it("uses the committee or regime as the program", () => {
    const programs = parse().tables.list_program.map((p) => [p.entry_id, p.program]);
    expect(programs).toEqual([
      ["UN-TST.001", "Libya"],
      ["UN-9000002", "DRC"],
      ["UN-TSTe.001", "DRC"],
    ]);
  });

  it("reads the same from a file and is repeatable", async () => {
    const fromFile = await parseUnFile(FIXTURE, options);
    expect(JSON.stringify(fromFile.tables)).toBe(JSON.stringify(parse().tables));
  });

  it("rejects input with no root", () => {
    expect(() => parseUnString("", options)).toThrow(/XML parse error/);
  });
});

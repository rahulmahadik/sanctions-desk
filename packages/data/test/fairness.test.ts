import { describe, expect, it } from "vitest";
import { type CustomerProfile, compareParty, type ListedParty, nameScore } from "../src/index.js";

/**
 * Fairness checks of the deterministic matching (no model takes part in matching). They state what holds and pin the
 * known limits, so a change in either shows up here. See docs/RESPONSIBLE_AI.md.
 */

describe("the same person written differently", () => {
  it("scores accents and letter case the same as the plain form", () => {
    expect(nameScore("Jose Muller", "José Müller").score).toBe(1);
    expect(nameScore("JOSÉ MÜLLER", "José Müller").score).toBe(1);
  });

  it("scores family-name-first and comma forms the same as each other, and above the 0.90 line", () => {
    const reordered = nameScore("Ivanov Sergei", "Sergei Ivanov").score;
    expect(nameScore("IVANOV, Sergei", "Sergei Ivanov").score).toBe(reordered);
    expect(reordered).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps common Latin spelling variants above the 0.90 line", () => {
    for (const [a, b] of [
      ["Sergey Ivanov", "Sergei Ivanov"],
      ["Serguei Ivanoff", "Sergei Ivanov"],
      ["Jose Mueller", "José Müller"],
      ["Muhammad Al Rashid", "Mohammed Al-Rashid"],
    ] as const)
      expect(nameScore(a, b).score).toBeGreaterThanOrEqual(0.9);
  });

  it("limit: does not transliterate between scripts, and some spellings fall below the line", () => {
    // A name in Cyrillic or Arabic matches only an alias the list itself gives in that script.
    expect(nameScore("Сергей Иванов", "Sergei Ivanov").score).toBe(0);
    expect(nameScore("محمد الراشد", "Mohammed Al-Rashid").score).toBe(0);
    expect(nameScore("Mohamed Alrashid", "Mohammed Al-Rashid").score).toBeLessThan(0.9);
  });
});

describe("nationality on its own", () => {
  const listed: ListedParty = {
    entryId: "OFAC-TEST",
    listId: "OFAC",
    kind: "individual",
    primaryName: "Karim Benali",
    aliases: [],
    dobs: [{ value: "1967-01-17", precision: "day", rangeFrom: null, rangeTo: null }],
    countries: [{ iso2: "DZ", role: "nationality" }],
    identifiers: [],
  };
  const customer = (nationality: string | null): CustomerProfile => ({
    customerId: "CUST-TEST",
    kind: "individual",
    name: "Karim Benali",
    otherNames: [],
    dateOfBirth: "1978-01-15",
    nationality,
    residence: nationality,
    identifiers: [],
  });
  const outcome = (nationality: string | null) => {
    const c = compareParty(customer(nationality), listed, { nameSimilarity: 0.9 });
    return { assessment: c.assessment, definitions: c.definitions, country: c.country.status };
  };

  it("gives the same comparison for different nationalities that are not the listed party's", () => {
    const de = outcome("DE");
    for (const n of ["FR", "BR", "NG", "IN", "CN"]) expect(outcome(n)).toEqual(de);
    expect(de.definitions.false_positive).toBe(true);
  });

  it("changes the comparison only when it agrees with the listed party's nationality, or is unknown", () => {
    expect(outcome("DZ").country).toBe("match");
    expect(outcome("DZ").definitions.false_positive).toBe(false);
    // Unknown nationality: the false-positive definition needs it, so such a customer cannot be cleared on it.
    expect(outcome(null).definitions.false_positive).toBe(false);
  });
});

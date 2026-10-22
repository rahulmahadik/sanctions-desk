import { describe, expect, it } from "vitest";
import {
  type CustomerProfile,
  companyCore,
  compareDob,
  compareParty,
  type ListedParty,
  personCore,
} from "../src/matching/compare.js";

const party = (over: Partial<ListedParty> = {}): ListedParty => ({
  entryId: "OFAC-1",
  listId: "OFAC",
  kind: "individual",
  primaryName: "IVANOV, Petr Sergeyevich",
  aliases: [{ name: "Pyotr Ivanov", type: "aka", strong: true }],
  dobs: [{ value: "1975-03-14", precision: "day", rangeFrom: null, rangeTo: null }],
  countries: [{ iso2: "RU", role: "nationality" }],
  identifiers: [{ type: "passport", number: "75 1234567", country: "RU" }],
  ...over,
});
const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  customerId: "C1",
  kind: "individual",
  name: "Petr Ivanov",
  otherNames: [],
  dateOfBirth: "1975-03-14",
  nationality: "RU",
  residence: "AE",
  identifiers: [],
  ...over,
});
const T = { nameSimilarity: 0.85 };

describe("compareDob", () => {
  const listed = [{ value: "1975", precision: "year", rangeFrom: null, rangeTo: null }];
  it("separates exact, compatible, conflicting and missing", () => {
    expect(compareDob("1975-03-14", party().dobs).status).toBe("exact");
    expect(compareDob("1975-03-14", listed).status).toBe("compatible");
    expect(compareDob("1980-01-01", listed).status).toBe("conflict");
    expect(compareDob(null, listed).status).toBe("missing_customer");
    expect(compareDob("1975", []).status).toBe("missing_list");
    expect(compareDob("not a date", listed).status).toBe("missing_customer");
  });
  it("uses a listed range", () => {
    const range = [{ value: null, precision: "range", rangeFrom: "1970-01-01", rangeTo: "1975-12-31" }];
    expect(compareDob("1973-06-01", range).status).toBe("compatible");
    expect(compareDob("1980-06-01", range).status).toBe("conflict");
  });
});

describe("personCore", () => {
  it("drops a leading title but keeps the name", () => {
    expect(personCore("Dr. Anna Weber")).toBe("anna weber");
    expect(personCore("Mr Ivan Petrov")).toBe("ivan petrov");
    expect(personCore("Dr")).toBe("dr");
  });
  it("matches a customer written with a title", () => {
    expect(
      compareParty(customer({ name: "Dr. Petr Ivanov" }), party(), { nameSimilarity: 0.85 }).name.score,
    ).toBeGreaterThanOrEqual(0.95);
  });
  it("flags a disguised name", () => {
    const r = compareParty(customer({ name: "Pеtr Ivаnov" }), party(), { nameSimilarity: 0.85 });
    expect(r.name.homoglyph).toBe(true);
    expect(r.reasons.join(" ")).toContain("look-alike");
  });
});

describe("companyCore", () => {
  it("drops legal-form words and spaced letters", () => {
    expect(companyCore("Baltic Trading L.L.C.")).toBe("baltic trading");
    expect(companyCore("Baltic Trading Limited")).toBe("baltic trading");
    expect(companyCore("Pte. Ltd. Orion Marine")).toBe("orion marine");
  });
});

describe("compareParty", () => {
  it("rates a name, date of birth and country agreement as strong", () => {
    const r = compareParty(customer(), party(), T);
    expect(r.assessment).toBe("strong");
    expect(r.dob.status).toBe("exact");
    expect(r.country.status).toBe("match");
    expect(r.strong_identifier_matches).toBe(2);
    expect(r.reasons[0]).toContain("name");
  });
  it("rates the same name with a conflicting date of birth and country as weak", () => {
    const r = compareParty(customer({ dateOfBirth: "1990-01-01", nationality: "GB", residence: "GB" }), party(), T);
    expect(r.assessment).toBe("weak");
    expect(r.dob.status).toBe("conflict");
  });
  it("tells a nationality match from an address-only country link", () => {
    const addressOnly = party({ countries: [{ iso2: "AE", role: "address" }] });
    const r = compareParty(customer({ nationality: "RU", residence: "AE" }), addressOnly, T);
    expect(r.country.status).toBe("address_only");
    expect(r.assessment).toBe("possible");
    expect(
      compareParty(customer({ nationality: "RU" }), party({ countries: [{ iso2: "KZ", role: "citizenship" }] }), T)
        .country.status,
    ).toBe("conflict");
    expect(compareParty(customer({ nationality: null, residence: null }), party(), T).country.status).toBe("unknown");
  });
  it("keeps a missing date of birth as possible", () => {
    expect(compareParty(customer({ dateOfBirth: null }), party(), T).assessment).toBe("possible");
  });
  it("treats an identifier match as strong", () => {
    const r = compareParty(
      customer({ name: "P. Ivanoff", dateOfBirth: null, identifiers: [{ type: "passport", number: "75-1234567" }] }),
      party(),
      T,
    );
    expect(r.identifiers.status).toBe("match");
    expect(r.assessment).toBe("strong");
  });
  it("uses aliases and company cores", () => {
    const entity = party({ kind: "entity", primaryName: "BALTIC TRADING LLC", aliases: [], dobs: [], identifiers: [] });
    const r = compareParty(customer({ kind: "company", name: "Baltic Trading Limited", dateOfBirth: null }), entity, T);
    expect(r.name.score).toBe(1);
    expect(r.assessment).toBe("possible");
  });
  it("marks a person-versus-company pair as a mismatch and weak", () => {
    const entity = party({ kind: "entity", primaryName: "Petr Ivanov", aliases: [], identifiers: [] });
    const r = compareParty(customer(), entity, T);
    expect(r.kind).toBe("mismatch");
    expect(r.assessment).toBe("weak");
  });
  it("discounts weak aliases", () => {
    const p = party({
      primaryName: "Other Name",
      aliases: [{ name: "Petr Ivanov", type: "low_quality", strong: false }],
    });
    expect(compareParty(customer(), p, T).name.score).toBe(0.9);
  });
  it("applies the approved definitions: true match needs name, day-exact date of birth and nationality or document", () => {
    expect(compareParty(customer(), party(), T).definitions).toEqual({
      true_match: true,
      false_positive: false,
      counterparty_match: false,
    });
    const viaDocument = compareParty(customer({ nationality: "KZ" }), party(), T, { identifierMatches: ["passport"] });
    expect(viaDocument.definitions.true_match).toBe(true);
    expect(compareParty(customer({ dateOfBirth: "1975" }), party(), T).definitions.true_match).toBe(false);
    expect(compareParty(customer({ nationality: "KZ" }), party(), T).definitions.true_match).toBe(false);
  });

  it("applies the false positive definition: date of birth conflicts, nationality known and different, no document", () => {
    const other = customer({ dateOfBirth: "1990-01-01", nationality: "GB", residence: "GB" });
    expect(compareParty(other, party(), T).definitions).toEqual({
      true_match: false,
      false_positive: true,
      counterparty_match: false,
    });
    expect(
      compareParty(customer({ dateOfBirth: "1990-01-01", nationality: null, residence: null }), party(), T).definitions
        .false_positive,
    ).toBe(false);
    expect(compareParty(other, party(), T, { identifierMatches: ["passport"] }).definitions.false_positive).toBe(false);
    expect(
      compareParty(customer({ dateOfBirth: null, nationality: "GB" }), party(), T).definitions.false_positive,
    ).toBe(false);
  });
});

describe("compareParty for a payment counterparty", () => {
  const company = party({
    kind: "entity",
    primaryName: "BALTIC TRADING LLC",
    aliases: [],
    dobs: [],
    countries: [{ iso2: "AE", role: "address" }],
    identifiers: [],
  });
  const counterparty = (name: string) =>
    customer({ kind: "company", name, dateOfBirth: null, nationality: null, residence: null, identifiers: [] });
  const T2 = { nameSimilarity: 0.85 };

  it("matches when the name agrees and the country is one linked to the listed party", () => {
    const r = compareParty(counterparty("Baltic Trading Limited"), company, T2, { payment: { country: "AE" } });
    expect(r.country.status).toBe("match");
    expect(r.definitions).toEqual({ true_match: false, false_positive: false, counterparty_match: true });
    expect(r.assessment).toBe("strong");
  });

  it("is a false positive when the name is similar but the country is different", () => {
    const r = compareParty(counterparty("Baltic Trading Limited"), company, T2, { payment: { country: "NL" } });
    expect(r.definitions).toEqual({ true_match: false, false_positive: true, counterparty_match: false });
    expect(r.assessment).toBe("weak");
  });

  it("cannot be cleared when the country is missing or not a country code", () => {
    for (const country of [null, "XX", ""]) {
      const r = compareParty(counterparty("Baltic Trading Limited"), company, T2, { payment: { country } });
      expect(r.country.status, String(country)).toBe("unknown");
      expect(r.definitions.counterparty_match).toBe(false);
      expect(r.definitions.false_positive).toBe(false);
      expect(r.assessment).toBe("possible");
    }
  });

  it("treats a document match as strong whatever the country", () => {
    const withDocument = party({
      ...company,
      identifiers: [{ type: "registration", number: "AB-12345", country: "AE" }],
    });
    const r = compareParty(
      { ...counterparty("Baltic Trading Limited"), identifiers: [{ type: "registration", number: "ab12345" }] },
      withDocument,
      T2,
      { payment: { country: "NL" } },
    );
    expect(r.assessment).toBe("strong");
    expect(r.definitions.false_positive).toBe(false);
  });
});

import type { CustomerProfile, ListedParty } from "./compare.js";

/**
 * Rows reach the matcher either as typed rows (files, generator) or as Zetaris results, where every
 * value is a string. These adapters accept both and cast explicitly.
 */

export type Row = Readonly<Record<string, unknown>>;

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const nullable = (v: unknown): string | null => {
  const s = text(v);
  return s === "" || s === "null" ? null : s;
};
const flag = (v: unknown): boolean => v === true || text(v).toLowerCase() === "true";

export interface PartyRows {
  entry: Row;
  aliases: readonly Row[];
  dobs: readonly Row[];
  countries: readonly Row[];
  identifiers: readonly Row[];
}

export function listedPartyFromRows(rows: PartyRows): ListedParty {
  return {
    entryId: text(rows.entry.entry_id),
    listId: text(rows.entry.list_id),
    kind: text(rows.entry.party_kind),
    primaryName: text(rows.entry.primary_name),
    aliases: rows.aliases.map((a) => ({
      name: text(a.alias_name),
      type: text(a.alias_type),
      strong: flag(a.is_strong),
    })),
    dobs: rows.dobs.map((d) => ({
      value: nullable(d.dob_value),
      precision: text(d.dob_precision),
      rangeFrom: nullable(d.range_from),
      rangeTo: nullable(d.range_to),
    })),
    countries: rows.countries.flatMap((c) => {
      const iso = nullable(c.country_iso2);
      return iso ? [{ iso2: iso, role: text(c.role) }] : [];
    }),
    identifiers: rows.identifiers.map((i) => ({
      type: text(i.id_type),
      number: text(i.id_number),
      country: nullable(i.issuing_country),
    })),
  };
}

export function customerProfileFromRows(customer: Row, identifiers: readonly Row[]): CustomerProfile {
  return {
    customerId: text(customer.customer_id),
    kind: text(customer.customer_type) === "company" ? "company" : "individual",
    name: text(customer.full_name),
    otherNames: [],
    dateOfBirth: nullable(customer.date_of_birth),
    nationality: nullable(customer.nationality),
    residence: nullable(customer.residence_country),
    identifiers: identifiers.map((i) => ({ type: text(i.id_type), number: text(i.id_number) })),
  };
}

/** Group typed list tables by entry id so each party is cheap to build. */
export function groupByEntry<T extends Row>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = text(row.entry_id);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

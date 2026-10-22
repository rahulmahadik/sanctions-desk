import { groupByEntry, listedPartyFromRows } from "../matching/adapters.js";
import type { ListedParty } from "../matching/compare.js";
import type { TableRows } from "../model.js";
import type { Rng } from "./random.js";

/**
 * Helpers for building synthetic customers from real listed parties: spelling variants, and the pools
 * of listed parties a scenario can start from.
 */

const SWAPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Mohammed|Muhammad|Mohamed/i, "Muhammad"],
  [/Hussein|Husayn|Hussain/i, "Husayn"],
  [/Yusuf|Yousef|Youssef/i, "Yousef"],
  [/Abdul|Abd al/i, "Abd al"],
  [/ov\b/i, "off"],
  [/ev\b/i, "yev"],
  [/ski\b/i, "sky"],
  [/\bAli\b/, "Aly"],
  [/ch/i, "tch"],
  [/Ahmad/i, "Ahmed"],
];

/** A spelling variant of a name: one transliteration-style change that keeps it recognisable. */
export function nameVariant(name: string): string {
  for (const [pattern, replacement] of SWAPS) {
    if (pattern.test(name)) {
      const out = name.replace(pattern, (found) => matchCase(found, replacement));
      if (out !== name) return out;
    }
  }
  const tokens = name.split(" ");
  if (tokens.length >= 3) return [tokens[0], tokens[tokens.length - 1]].join(" ");
  return name.replace(/([aeiou])/i, (m) => matchCase(m, m.toLowerCase() === "e" ? "i" : "e"));
}

/** Give a replacement the capitalisation style of the text it replaces. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase();
  if (original === original.toLowerCase()) return replacement.toLowerCase();
  return replacement;
}

const COMMON_RESIDENCES = ["GB", "DE", "SG", "AE", "CH", "NL", "FR", "HK"];

export interface Candidate {
  party: ListedParty;
  natural: string;
}

/** Build the candidate pools from the sample tables. */
export function candidatesFrom(tables: TableRows): Candidate[] {
  const aliases = groupByEntry(tables.list_alias);
  const dobs = groupByEntry(tables.list_dob);
  const countries = groupByEntry(tables.list_country);
  const identifiers = groupByEntry(tables.list_identifier);
  return tables.list_entry.map((entry) => ({
    natural: entry.primary_name,
    party: listedPartyFromRows({
      entry,
      aliases: aliases.get(entry.entry_id) ?? [],
      dobs: dobs.get(entry.entry_id) ?? [],
      countries: countries.get(entry.entry_id) ?? [],
      identifiers: identifiers.get(entry.entry_id) ?? [],
    }),
  }));
}

export const isLatin = (s: string): boolean => /^[\p{Script=Latin}\p{N}\s.,'’\-()&/]+$/u.test(s);

/** The listed party's nationality only; an address country is not a nationality. */
export function nationalityOf(p: ListedParty): string | null {
  return p.countries.find((c) => c.role === "nationality" || c.role === "citizenship")?.iso2 ?? null;
}
export function fullDobOf(p: ListedParty): string | null {
  return p.dobs.find((d) => d.precision === "day")?.value ?? null;
}
export function yearOf(p: ListedParty): string | null {
  const v = p.dobs.find((d) => d.value !== null)?.value;
  return v ? v.slice(0, 4) : null;
}

export const person = (c: Candidate): boolean =>
  c.party.kind === "individual" && isLatin(c.natural) && c.natural.split(" ").length >= 2;
export const company = (c: Candidate): boolean => c.party.kind === "entity" && isLatin(c.natural);

/** A country other than the ones given, for customers who must differ from the listed party. */
export function otherCountry(rng: Rng, avoid: readonly (string | null)[]): string {
  return rng.pick(COMMON_RESIDENCES.filter((c) => !avoid.includes(c)));
}

export { COMMON_RESIDENCES };

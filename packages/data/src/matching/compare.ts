import { isIso2 } from "../countries.js";
import { normaliseName, windowOfIso, type YMD } from "../text.js";
import { nameScore, tokensOf } from "./similarity.js";

/**
 * Deterministic comparison of a customer (or a payment party) with one listed party.
 * The result carries the evidence for every field, so a reviewer can see why it was rated as it was.
 */

export interface ListedAlias {
  name: string;
  type: string;
  strong: boolean;
}
export interface ListedDob {
  value: string | null;
  precision: string;
  rangeFrom: string | null;
  rangeTo: string | null;
}
export interface ListedParty {
  entryId: string;
  listId: string;
  kind: string;
  primaryName: string;
  aliases: ListedAlias[];
  dobs: ListedDob[];
  countries: Array<{ iso2: string; role: string }>;
  identifiers: Array<{ type: string; number: string; country: string | null }>;
}
export interface CustomerProfile {
  customerId: string;
  kind: "individual" | "company";
  name: string;
  otherNames: string[];
  dateOfBirth: string | null;
  nationality: string | null;
  residence: string | null;
  identifiers: Array<{ type: string; number: string }>;
}

export interface MatchThresholds {
  nameSimilarity: number;
}

export type DobStatus = "exact" | "compatible" | "conflict" | "missing_customer" | "missing_list";
/** match: nationality agrees. address_only: only an address or other link agrees. */
export type CountryStatus = "match" | "address_only" | "conflict" | "unknown";
export type IdStatus = "match" | "none";
export type Assessment = "strong" | "possible" | "weak";

export interface PartyComparison {
  entry_id: string;
  list_id: string;
  name: {
    score: number;
    method: string;
    customer_name: string;
    listed_name: string;
    alias_type: string;
    homoglyph: boolean;
  };
  kind: "match" | "mismatch";
  dob: { status: DobStatus; customer: string | null; listed: string[] };
  country: { status: CountryStatus; customer: string | null; listed: string[] };
  identifiers: { status: IdStatus; matches: string[] };
  strong_identifier_matches: number;
  /** The approved definitions, applied by code (business definitions true_match@1, false_positive@1 and counterparty_match@1). */
  definitions: { true_match: boolean; false_positive: boolean; counterparty_match: boolean };
  assessment: Assessment;
  reasons: string[];
}

/** Titles that are not part of a person's name. Only stripped from the front of a name. */
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "dame", "lord", "hon"]);

/** A person's name without a leading title ("Dr. Anna Weber" is "Anna Weber"). */
export function personCore(name: string): string {
  const tokens = tokensOf(normaliseName(name));
  const first = tokens[0];
  return first !== undefined && HONORIFICS.has(first) && tokens.length > 1
    ? tokens.slice(1).join(" ")
    : tokens.join(" ");
}

const SUFFIXES = new Set([
  "llc",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "ag",
  "sa",
  "sarl",
  "bv",
  "nv",
  "plc",
  "jsc",
  "pjsc",
  "ooo",
  "oao",
  "zao",
  "fze",
  "fzco",
  "pte",
  "sdn",
  "bhd",
  "lp",
  "llp",
  "spa",
  "srl",
  "ab",
  "as",
  "oy",
  "kg",
  "ug",
]);

/** The distinctive part of a company name: legal-form words and letters (L.L.C., Pte. Ltd) removed. */
export function companyCore(name: string): string {
  const merged = normaliseName(name).replace(/\b([a-z]) (?=[a-z]\b)/g, "$1");
  return tokensOf(merged)
    .filter((t) => !SUFFIXES.has(t))
    .join(" ");
}

function keyOf(d: YMD): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

function listedWindow(d: ListedDob): { from: YMD; to: YMD } | null {
  if (d.value) return windowOfIso(d.value);
  const from = d.rangeFrom ? windowOfIso(d.rangeFrom) : null;
  const to = d.rangeTo ? windowOfIso(d.rangeTo) : null;
  return from && to ? { from: from.from, to: to.to } : null;
}

function describeListedDob(d: ListedDob): string {
  return d.value ?? `${d.rangeFrom ?? "?"}..${d.rangeTo ?? "?"}`;
}

export function compareDob(customerDob: string | null, listed: readonly ListedDob[]): PartyComparison["dob"] {
  const listedText = listed.map(describeListedDob);
  if (!customerDob) return { status: "missing_customer", customer: null, listed: listedText };
  if (listed.length === 0) return { status: "missing_list", customer: customerDob, listed: listedText };
  const mine = windowOfIso(customerDob);
  if (!mine) return { status: "missing_customer", customer: customerDob, listed: listedText };
  let compatible = false;
  for (const d of listed) {
    const w = listedWindow(d);
    if (!w) continue;
    if (keyOf(mine.from) <= keyOf(w.to) && keyOf(w.from) <= keyOf(mine.to)) {
      if (d.precision === "day" && d.value === customerDob)
        return { status: "exact", customer: customerDob, listed: listedText };
      compatible = true;
    }
  }
  return { status: compatible ? "compatible" : "conflict", customer: customerDob, listed: listedText };
}

const NATIONALITY_ROLES = new Set(["nationality", "citizenship"]);

function compareCountry(customer: CustomerProfile, party: ListedParty): PartyComparison["country"] {
  const listed = [...new Set(party.countries.map((c) => c.iso2))];
  const nationalities = new Set(party.countries.filter((c) => NATIONALITY_ROLES.has(c.role)).map((c) => c.iso2));
  const mine = [customer.nationality, customer.residence].filter((c): c is string => !!c);
  const base = { customer: customer.nationality, listed };
  if (mine.length === 0 || listed.length === 0) return { status: "unknown", ...base };
  if (customer.nationality && nationalities.has(customer.nationality)) return { status: "match", ...base };
  if (mine.some((c) => listed.includes(c))) return { status: "address_only", ...base };
  return { status: "conflict", ...base };
}

const compact = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

function compareIdentifiers(customer: CustomerProfile, party: ListedParty): PartyComparison["identifiers"] {
  const listed = new Set(party.identifiers.map((i) => compact(i.number)).filter((n) => n.length >= 5));
  const matches = customer.identifiers.filter((i) => listed.has(compact(i.number))).map((i) => i.type);
  return { status: matches.length > 0 ? "match" : "none", matches };
}

function bestName(customer: CustomerProfile, party: ListedParty) {
  const isCompany = customer.kind === "company";
  const prep = (s: string) => (isCompany ? companyCore(s) : personCore(s));
  const mine = [customer.name, ...customer.otherNames];
  const theirs = [
    { name: party.primaryName, type: "primary", strong: true },
    ...party.aliases.filter((a) => a.name !== party.primaryName),
  ];
  let best = {
    score: 0,
    method: "none",
    customer_name: customer.name,
    listed_name: party.primaryName,
    alias_type: "primary",
    homoglyph: false,
  };
  for (const m of mine) {
    for (const t of theirs) {
      const r = nameScore(prep(m), prep(t.name));
      const weight = t.strong ? 1 : 0.9;
      const score = Math.round(r.score * weight * 1000) / 1000;
      if (score > best.score)
        best = {
          score,
          method: r.method,
          customer_name: m,
          listed_name: t.name,
          alias_type: t.type,
          homoglyph: r.homoglyph === true,
        };
    }
  }
  return best;
}

const KIND_OF: Record<string, CustomerProfile["kind"] | undefined> = { individual: "individual", entity: "company" };

interface AssessInput {
  kind: PartyComparison["kind"];
  identifiers: PartyComparison["identifiers"];
  nameHigh: boolean;
  nameScore: number;
  dob: PartyComparison["dob"];
  country: PartyComparison["country"];
}

/** How strongly the evidence points to the same party. Order matters: the first rule that fits wins. */
function assess(i: AssessInput): Assessment {
  if (i.kind === "mismatch" && i.identifiers.status !== "match") return "weak";
  if (i.identifiers.status === "match" && (i.nameHigh || i.nameScore >= 0.7)) return "strong";
  if (i.nameHigh && i.dob.status === "exact" && i.country.status === "match") return "strong";
  if (i.nameHigh && i.dob.status !== "conflict") return "possible";
  if (i.nameHigh && i.dob.status === "conflict" && i.country.status === "match") return "possible";
  return "weak";
}

function reasonsOf(i: Pick<PartyComparison, "name" | "dob" | "country" | "identifiers" | "kind">): string[] {
  const reasons = [
    `name ${i.name.score.toFixed(2)} (${i.name.method}) vs ${i.name.alias_type} "${i.name.listed_name}"`,
    `date of birth: ${i.dob.status}`,
    `country: ${i.country.status}`,
  ];
  if (i.identifiers.status === "match") reasons.push(`identifier match: ${i.identifiers.matches.join(", ")}`);
  if (i.kind === "mismatch") reasons.push("party type differs (person vs company)");
  if (i.name.homoglyph) reasons.push("name mixes look-alike letters from another script (possible disguise)");
  return reasons;
}

/** true_match@1: names agree, date of birth agrees to the day, and nationality or a document number agrees. */
function meetsTrueMatch(i: AssessInput): boolean {
  return i.nameHigh && i.dob.status === "exact" && (i.country.status === "match" || i.identifiers.status === "match");
}

/** false_positive@1: date of birth conflicts, nationality is known and differs, and no document number matches. */
function meetsFalsePositive(i: AssessInput, customerNationality: string | null): boolean {
  return (
    i.dob.status === "conflict" &&
    customerNationality !== null &&
    (i.country.status === "conflict" || i.country.status === "address_only") &&
    i.identifiers.status !== "match"
  );
}

/** The country of a payment counterparty against the countries linked to a listed party. */
function comparePaymentCountry(country: string | null, party: ListedParty): PartyComparison["country"] {
  const listed = [...new Set(party.countries.map((c) => c.iso2))];
  const base = { customer: country, listed };
  if (!country || !isIso2(country)) return { status: "unknown", ...base };
  if (listed.length === 0) return { status: "unknown", ...base };
  return { status: listed.includes(country) ? "match" : "conflict", ...base };
}

/** counterparty_match@1: the counterparty name agrees and its country is one linked to the listed party. */
function paymentAssessment(
  nameHigh: boolean,
  nameScore: number,
  country: PartyComparison["country"],
  identifiers: PartyComparison["identifiers"],
): Assessment {
  if (identifiers.status === "match" && nameScore >= 0.7) return "strong";
  if (nameHigh && country.status === "match") return "strong";
  if (nameHigh && country.status === "unknown") return "possible";
  return "weak";
}

export interface CompareOptions {
  /** Compare a payment counterparty rather than a customer: only the name and the country are known. */
  payment?: { country: string | null };
  /**
   * Identifier types that matched, worked out where the numbers are visible (inside the data layer).
   * When given, the numbers on the customer and the listed party are not compared here.
   */
  identifierMatches?: readonly string[];
}

export function compareParty(
  customer: CustomerProfile,
  party: ListedParty,
  thresholds: MatchThresholds,
  options: CompareOptions = {},
): PartyComparison {
  const name = bestName(customer, party);
  const listedKind = KIND_OF[party.kind];
  const kind = listedKind === undefined || listedKind === customer.kind ? "match" : "mismatch";
  const dob = compareDob(customer.dateOfBirth, party.dobs);
  const country = options.payment
    ? comparePaymentCountry(options.payment.country, party)
    : compareCountry(customer, party);
  const identifiers =
    options.identifierMatches === undefined
      ? compareIdentifiers(customer, party)
      : {
          status: options.identifierMatches.length > 0 ? ("match" as const) : ("none" as const),
          matches: [...options.identifierMatches],
        };

  const strong =
    (dob.status === "exact" ? 1 : 0) + (country.status === "match" ? 1 : 0) + (identifiers.status === "match" ? 1 : 0);
  const nameHigh = name.score >= thresholds.nameSimilarity;

  const input: AssessInput = { kind, identifiers, nameHigh, nameScore: name.score, dob, country };
  const assessment = options.payment ? paymentAssessment(nameHigh, name.score, country, identifiers) : assess(input);
  const definitions = options.payment
    ? {
        true_match: false,
        false_positive: country.status === "conflict" && identifiers.status !== "match",
        counterparty_match: nameHigh && country.status === "match",
      }
    : {
        true_match: meetsTrueMatch(input),
        false_positive: meetsFalsePositive(input, customer.nationality),
        counterparty_match: false,
      };
  const reasons = reasonsOf({ name, dob, country, identifiers, kind });
  return {
    entry_id: party.entryId,
    list_id: party.listId,
    name,
    kind,
    dob,
    country,
    identifiers,
    strong_identifier_matches: strong,
    definitions,
    assessment,
    reasons,
  };
}

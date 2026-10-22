import type { Decision } from "@sanctions-desk/shared";
import { groupByEntry, listedPartyFromRows } from "../matching/adapters.js";
import type { ListedParty } from "../matching/compare.js";
import { shortHash, type TableRows } from "../model.js";
import type { Rng } from "./random.js";

/**
 * Scenario builders. Each one turns a real listed party into a synthetic customer with a known,
 * labelled outcome. The labels feed the exam; the agents never see them.
 */

export type ScenarioKind =
  | "true_match_exact"
  | "true_match_variant"
  | "false_positive_dob"
  | "false_positive_surname"
  | "false_positive_country"
  | "missing_dob"
  | "partial_dob_year"
  | "identifier_match"
  | "company_suffix_variant"
  | "company_other_country"
  | "non_latin_alias";

export interface ScenarioCustomer {
  full_name: string;
  customer_type: "individual" | "company";
  date_of_birth: string | null;
  nationality: string | null;
  residence_country: string;
  identifier?: {
    id_type: "passport" | "national_id" | "tax_id" | "registration";
    id_number: string;
    issuing_country: string | null;
  };
}

export interface Scenario {
  kind: ScenarioKind;
  entry_id: string;
  list_id: "OFAC" | "UN";
  customer: ScenarioCustomer;
  expected: Decision;
  /** Other decisions that are acceptable, and why. */
  acceptable: Decision[];
  note: string;
}

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

function nationalityOf(p: ListedParty): string | null {
  return (
    p.countries.find((c) => c.role === "nationality" || c.role === "citizenship")?.iso2 ?? p.countries[0]?.iso2 ?? null
  );
}
function fullDobOf(p: ListedParty): string | null {
  return p.dobs.find((d) => d.precision === "day")?.value ?? null;
}
function yearOf(p: ListedParty): string | null {
  const v = p.dobs.find((d) => d.value !== null)?.value;
  return v ? v.slice(0, 4) : null;
}

function otherCountry(rng: Rng, avoid: readonly (string | null)[]): string {
  return rng.pick(COMMON_RESIDENCES.filter((c) => !avoid.includes(c)));
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

const isLatin = (s: string): boolean => /^[\p{Script=Latin}\p{N}\s.,'’\-()&/]+$/u.test(s);
const shared = (rank: string) => (a: Candidate, b: Candidate) =>
  shortHash(rank, a.party.entryId).localeCompare(shortHash(rank, b.party.entryId));

export interface ScenarioPlan {
  kind: ScenarioKind;
  count: number;
}

type Builder = (c: Candidate, rng: Rng) => Scenario | null;

const person = (c: Candidate) =>
  c.party.kind === "individual" && isLatin(c.natural) && c.natural.split(" ").length >= 2;
const company = (c: Candidate) => c.party.kind === "entity" && isLatin(c.natural);

const BUILDERS: Record<ScenarioKind, { eligible: (c: Candidate) => boolean; build: Builder }> = {
  true_match_exact: {
    eligible: (c) => person(c) && fullDobOf(c.party) !== null && nationalityOf(c.party) !== null,
    build: (c, rng) => ({
      kind: "true_match_exact",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: c.natural,
        customer_type: "individual",
        date_of_birth: fullDobOf(c.party),
        nationality: nationalityOf(c.party),
        residence_country: rng.pick(COMMON_RESIDENCES),
      },
      expected: "ESCALATE_L2",
      acceptable: ["RECOMMEND_BLOCK"],
      note: "Name, date of birth and nationality all agree with the listed person.",
    }),
  },
  true_match_variant: {
    eligible: (c) =>
      person(c) &&
      fullDobOf(c.party) !== null &&
      nationalityOf(c.party) !== null &&
      nameVariant(c.natural) !== c.natural,
    build: (c, rng) => ({
      kind: "true_match_variant",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: nameVariant(c.natural),
        customer_type: "individual",
        date_of_birth: fullDobOf(c.party),
        nationality: nationalityOf(c.party),
        residence_country: rng.pick(COMMON_RESIDENCES),
      },
      expected: "ESCALATE_L2",
      acceptable: ["RECOMMEND_BLOCK"],
      note: "A transliteration-style spelling variant with the same date of birth and nationality.",
    }),
  },
  false_positive_dob: {
    eligible: (c) => person(c) && fullDobOf(c.party) !== null,
    build: (c, rng) => {
      const year = Number(fullDobOf(c.party)?.slice(0, 4));
      const other = year + rng.pick([-14, -11, 9, 13, 17]);
      return {
        kind: "false_positive_dob",
        entry_id: c.party.entryId,
        list_id: c.party.listId as "OFAC" | "UN",
        customer: {
          full_name: c.natural,
          customer_type: "individual",
          date_of_birth: `${other}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
          nationality: otherCountry(rng, [nationalityOf(c.party)]),
          residence_country: rng.pick(COMMON_RESIDENCES),
        },
        expected: "CLOSE_FALSE_POSITIVE",
        acceptable: [],
        note: "Same name, but the date of birth and the nationality both differ from the listed person.",
      };
    },
  },
  false_positive_surname: {
    eligible: (c) => person(c) && /^\p{L}{4,}$/u.test(c.natural.split(" ").at(-1) ?? ""),
    build: (c, rng) => {
      const tokens = c.natural.split(" ");
      const surname = tokens[tokens.length - 1] as string;
      const given = rng.pick(["Daniel", "Sofia", "Lucas", "Mia", "Oliver", "Emma", "Noah", "Hannah"]);
      return {
        kind: "false_positive_surname",
        entry_id: c.party.entryId,
        list_id: c.party.listId as "OFAC" | "UN",
        customer: {
          full_name: `${given} ${surname}`,
          customer_type: "individual",
          date_of_birth: `${rng.int(1960, 2000)}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
          nationality: otherCountry(rng, [nationalityOf(c.party)]),
          residence_country: rng.pick(COMMON_RESIDENCES),
        },
        expected: "CLOSE_FALSE_POSITIVE",
        acceptable: [],
        note: "Only the surname is shared; given name, date of birth and nationality differ.",
      };
    },
  },
  false_positive_country: {
    eligible: (c) => person(c) && yearOf(c.party) !== null && nationalityOf(c.party) !== null,
    build: (c, rng) => ({
      kind: "false_positive_country",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: c.natural,
        customer_type: "individual",
        date_of_birth: `${Number(yearOf(c.party)) + rng.pick([-20, -16, 15, 22])}-06-15`,
        nationality: otherCountry(rng, [nationalityOf(c.party)]),
        residence_country: rng.pick(COMMON_RESIDENCES),
      },
      expected: "CLOSE_FALSE_POSITIVE",
      acceptable: [],
      note: "Same full name; date of birth is decades apart and the nationality differs.",
    }),
  },
  missing_dob: {
    eligible: (c) => person(c) && fullDobOf(c.party) !== null,
    build: (c, rng) => ({
      kind: "missing_dob",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: c.natural,
        customer_type: "individual",
        date_of_birth: null,
        nationality: nationalityOf(c.party),
        residence_country: rng.pick(COMMON_RESIDENCES),
      },
      expected: "NEED_MORE_INFO",
      acceptable: ["ESCALATE_L2"],
      note: "The customer has no date of birth on file, so the match cannot be confirmed or ruled out.",
    }),
  },
  partial_dob_year: {
    eligible: (c) => person(c) && c.party.dobs.some((d) => d.precision === "year" || d.precision === "month"),
    build: (c, rng) => ({
      kind: "partial_dob_year",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: c.natural,
        customer_type: "individual",
        date_of_birth: yearOf(c.party),
        nationality: nationalityOf(c.party),
        residence_country: rng.pick(COMMON_RESIDENCES),
      },
      expected: "ESCALATE_L2",
      acceptable: ["NEED_MORE_INFO"],
      note: "Only the birth year is known on both sides and it agrees; it cannot be ruled out.",
    }),
  },
  identifier_match: {
    eligible: (c) => person(c) && c.party.identifiers.some((i) => i.type === "passport" && i.number.length >= 6),
    build: (c, rng) => {
      const passport = c.party.identifiers.find((i) => i.type === "passport" && i.number.length >= 6);
      return {
        kind: "identifier_match",
        entry_id: c.party.entryId,
        list_id: c.party.listId as "OFAC" | "UN",
        customer: {
          full_name: nameVariant(c.natural),
          customer_type: "individual",
          date_of_birth: null,
          nationality: nationalityOf(c.party),
          residence_country: rng.pick(COMMON_RESIDENCES),
          identifier: {
            id_type: "passport",
            id_number: passport?.number ?? "",
            issuing_country: passport?.country ?? null,
          },
        },
        expected: "ESCALATE_L2",
        acceptable: ["RECOMMEND_BLOCK"],
        note: "The passport number on file equals a passport number on the list.",
      };
    },
  },
  company_suffix_variant: {
    eligible: (c) =>
      company(c) &&
      /\b(LLC|LTD|LIMITED|INC|CO|COMPANY|CORP|GMBH|PTE)\b/i.test(c.natural) &&
      c.party.countries.length > 0,
    build: (c, rng) => ({
      kind: "company_suffix_variant",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: c.natural
          .replace(/\bLLC\b/i, "L.L.C.")
          .replace(/\bLTD\b/i, "Limited")
          .replace(/\bINC\b/i, "Incorporated")
          .replace(/\bCO\b/i, "Company"),
        customer_type: "company",
        date_of_birth: null,
        nationality: null,
        residence_country: c.party.countries[0]?.iso2 ?? rng.pick(COMMON_RESIDENCES),
      },
      expected: "ESCALATE_L2",
      acceptable: ["NEED_MORE_INFO"],
      note: "Same company with a different legal-form spelling, registered in the same country.",
    }),
  },
  company_other_country: {
    eligible: (c) => company(c) && c.party.countries.length > 0,
    build: (c, rng) => ({
      kind: "company_other_country",
      entry_id: c.party.entryId,
      list_id: c.party.listId as "OFAC" | "UN",
      customer: {
        full_name: c.natural,
        customer_type: "company",
        date_of_birth: null,
        nationality: null,
        residence_country: otherCountry(
          rng,
          c.party.countries.map((x) => x.iso2),
        ),
      },
      expected: "NEED_MORE_INFO",
      acceptable: ["ESCALATE_L2", "CLOSE_FALSE_POSITIVE"],
      note: "Identical company name registered in an unrelated country; a registration number would settle it.",
    }),
  },
  non_latin_alias: {
    eligible: (c) =>
      person(c) &&
      c.party.aliases.some((a) => !isLatin(a.name)) &&
      fullDobOf(c.party) !== null &&
      nationalityOf(c.party) !== null,
    build: (c, rng) => {
      const alias = c.party.aliases.find((a) => !isLatin(a.name));
      return {
        kind: "non_latin_alias",
        entry_id: c.party.entryId,
        list_id: c.party.listId as "OFAC" | "UN",
        customer: {
          full_name: alias?.name ?? c.natural,
          customer_type: "individual",
          date_of_birth: fullDobOf(c.party),
          nationality: nationalityOf(c.party),
          residence_country: rng.pick(COMMON_RESIDENCES),
        },
        expected: "ESCALATE_L2",
        acceptable: ["RECOMMEND_BLOCK"],
        note: "The customer's name is written in the listed person's original script; date of birth agrees.",
      };
    },
  },
};

/** Pick distinct listed parties for each scenario in the plan, in a repeatable order. */
export function planScenarios(
  candidates: readonly Candidate[],
  plans: readonly ScenarioPlan[],
  rng: Rng,
  seed: string,
): Scenario[] {
  const used = new Set<string>();
  const out: Scenario[] = [];
  for (const plan of plans) {
    const builder = BUILDERS[plan.kind];
    const pool = candidates.filter(builder.eligible).sort(shared(`${seed}:${plan.kind}`));
    let made = 0;
    for (const candidate of pool) {
      if (made >= plan.count) break;
      if (used.has(candidate.party.entryId)) continue;
      const scenario = builder.build(candidate, rng);
      if (!scenario) continue;
      used.add(candidate.party.entryId);
      out.push(scenario);
      made += 1;
    }
  }
  return out;
}

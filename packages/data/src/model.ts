import { hashValue, sha256Hex } from "@sanctions-desk/shared";
import { z } from "zod";

/**
 * The normalised sanctions-list tables. Each table maps one to one onto a table of the Unified
 * Semantic Layer in Zetaris (see zetaris/sql): same names, same columns, flat rows, no nesting.
 * Every row carries the stable id of its entry, so a snapshot can be loaded alongside earlier ones.
 */

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const LIST_IDS = ["OFAC", "UN"] as const;
export const ListIdSchema = z.enum(LIST_IDS);
export type ListSource = z.infer<typeof ListIdSchema>;

export const PARTY_KINDS = ["individual", "entity", "vessel", "aircraft", "other"] as const;
export const PartyKindSchema = z.enum(PARTY_KINDS);
export type PartyKind = z.infer<typeof PartyKindSchema>;

export const ALIAS_TYPES = ["primary", "aka", "fka", "nka", "low_quality"] as const;
export const AliasTypeSchema = z.enum(ALIAS_TYPES);

export const ID_TYPES = [
  "passport",
  "national_id",
  "tax_id",
  "registration",
  "drivers_license",
  "swift_bic",
  "vessel_imo",
  "aircraft_id",
  "other",
] as const;
export const IdTypeSchema = z.enum(ID_TYPES);

export const COUNTRY_ROLES = [
  "nationality",
  "citizenship",
  "registered_in",
  "address",
  "place_of_birth",
  "other",
] as const;
export const CountryRoleSchema = z.enum(COUNTRY_ROLES);

export const DOB_PRECISIONS = ["day", "month", "year", "range"] as const;

export const ListEntryRowSchema = z.strictObject({
  entry_id: nonEmpty,
  list_id: ListIdSchema,
  source_uid: nonEmpty,
  party_kind: PartyKindSchema,
  primary_name: nonEmpty,
  primary_name_script: nonEmpty,
  name_normalised: z.string(),
  listed_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  sanctions_list: nonEmpty,
  remarks: z.string().nullable(),
  snapshot_id: nonEmpty,
  content_hash: sha256,
});
export type ListEntryRow = z.infer<typeof ListEntryRowSchema>;

export const ListAliasRowSchema = z.strictObject({
  alias_id: nonEmpty,
  entry_id: nonEmpty,
  alias_name: nonEmpty,
  alias_type: AliasTypeSchema,
  script: nonEmpty,
  name_normalised: z.string(),
  is_primary: z.boolean(),
  is_strong: z.boolean(),
});
export type ListAliasRow = z.infer<typeof ListAliasRowSchema>;

export const ListIdentifierRowSchema = z.strictObject({
  identifier_id: nonEmpty,
  entry_id: nonEmpty,
  id_type: IdTypeSchema,
  id_number: nonEmpty,
  issuing_country: z.string().length(2).nullable(),
  note: z.string().nullable(),
});
export type ListIdentifierRow = z.infer<typeof ListIdentifierRowSchema>;

export const ListDobRowSchema = z.strictObject({
  dob_id: nonEmpty,
  entry_id: nonEmpty,
  /** YYYY, YYYY-MM or YYYY-MM-DD, at the stated precision. Null for a range. */
  dob_value: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  precision: z.enum(DOB_PRECISIONS),
  range_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  range_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  is_approximate: z.boolean(),
});
export type ListDobRow = z.infer<typeof ListDobRowSchema>;

export const ListCountryRowSchema = z.strictObject({
  country_link_id: nonEmpty,
  entry_id: nonEmpty,
  country_iso2: z.string().length(2).nullable(),
  country_name: z.string().nullable(),
  role: CountryRoleSchema,
  place: z.string().nullable(),
});
export type ListCountryRow = z.infer<typeof ListCountryRowSchema>;

export const ListProgramRowSchema = z.strictObject({
  program_id: nonEmpty,
  entry_id: nonEmpty,
  program: nonEmpty,
});
export type ListProgramRow = z.infer<typeof ListProgramRowSchema>;

export const ListRelationshipRowSchema = z.strictObject({
  relationship_id: nonEmpty,
  from_entry_id: nonEmpty,
  to_entry_id: nonEmpty,
  relation_type: nonEmpty,
  is_former: z.boolean(),
});
export type ListRelationshipRow = z.infer<typeof ListRelationshipRowSchema>;

export const RefCountryRowSchema = z.strictObject({ iso2: z.string().length(2), name: nonEmpty });
export type RefCountryRow = z.infer<typeof RefCountryRowSchema>;

export const RefLeiRowSchema = z.strictObject({
  lei: z.string().regex(/^[A-Z0-9]{20}$/),
  legal_name: nonEmpty,
  country_iso2: z.string().length(2).nullable(),
  city: z.string().nullable(),
  legal_form_id: z.string().nullable(),
  category: z.string().nullable(),
  entity_status: z.string().nullable(),
  registered_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});
export type RefLeiRow = z.infer<typeof RefLeiRowSchema>;

export const RefLeiRelationshipRowSchema = z.strictObject({
  relationship_id: nonEmpty,
  child_lei: z.string().regex(/^[A-Z0-9]{20}$/),
  parent_lei: z.string().regex(/^[A-Z0-9]{20}$/),
  relationship_type: nonEmpty,
  status: nonEmpty,
  valid_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  corroboration_level: z.string().nullable(),
});
export type RefLeiRelationshipRow = z.infer<typeof RefLeiRelationshipRowSchema>;

/** Reference tables loaded into Zetaris next to the list tables. */
export const REFERENCE_TABLES = {
  ref_country: RefCountryRowSchema,
  ref_lei: RefLeiRowSchema,
  ref_lei_relationship: RefLeiRelationshipRowSchema,
} as const;
export type ReferenceTableName = keyof typeof REFERENCE_TABLES;
export const REFERENCE_TABLE_COLUMNS: Record<ReferenceTableName, readonly string[]> = {
  ref_country: ["iso2", "name"],
  ref_lei: ["lei", "legal_name", "country_iso2", "city", "legal_form_id", "category", "entity_status", "registered_on"],
  ref_lei_relationship: [
    "relationship_id",
    "child_lei",
    "parent_lei",
    "relationship_type",
    "status",
    "valid_from",
    "corroboration_level",
  ],
};

export const TABLES = {
  list_entry: ListEntryRowSchema,
  list_alias: ListAliasRowSchema,
  list_identifier: ListIdentifierRowSchema,
  list_dob: ListDobRowSchema,
  list_country: ListCountryRowSchema,
  list_program: ListProgramRowSchema,
  list_relationship: ListRelationshipRowSchema,
} as const;

export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/** Column order of each table, as written in CSV and in the Zetaris DDL. */
export const TABLE_COLUMNS: Record<TableName, readonly string[]> = {
  list_entry: [
    "entry_id",
    "list_id",
    "source_uid",
    "party_kind",
    "primary_name",
    "primary_name_script",
    "name_normalised",
    "listed_on",
    "sanctions_list",
    "remarks",
    "snapshot_id",
    "content_hash",
  ],
  list_alias: [
    "alias_id",
    "entry_id",
    "alias_name",
    "alias_type",
    "script",
    "name_normalised",
    "is_primary",
    "is_strong",
  ],
  list_identifier: ["identifier_id", "entry_id", "id_type", "id_number", "issuing_country", "note"],
  list_dob: ["dob_id", "entry_id", "dob_value", "precision", "range_from", "range_to", "is_approximate"],
  list_country: ["country_link_id", "entry_id", "country_iso2", "country_name", "role", "place"],
  list_program: ["program_id", "entry_id", "program"],
  list_relationship: ["relationship_id", "from_entry_id", "to_entry_id", "relation_type", "is_former"],
};

/** Row types by table name. */
export interface TableRows {
  list_entry: ListEntryRow[];
  list_alias: ListAliasRow[];
  list_identifier: ListIdentifierRow[];
  list_dob: ListDobRow[];
  list_country: ListCountryRow[];
  list_program: ListProgramRow[];
  list_relationship: ListRelationshipRow[];
}

export const SnapshotMetaSchema = z.strictObject({
  snapshot_id: nonEmpty,
  source_id: nonEmpty,
  list_id: ListIdSchema,
  sanctions_list: nonEmpty,
  source_url: z.string(),
  fetched_at: z.iso.datetime(),
  /** Date the publisher says the list was issued, when the file states one. */
  issued_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  raw_file: nonEmpty,
  raw_sha256: sha256,
  raw_bytes: z.number().int().nonnegative(),
  parser_version: nonEmpty,
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** Present only on snapshots built for demonstration; they are never real published lists. */
  synthetic: z.strictObject({ label: nonEmpty, base_snapshot_id: nonEmpty }).optional(),
});
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

export interface NormalisedSnapshot {
  meta: SnapshotMeta;
  tables: TableRows;
}

export const PARSER_VERSION = "1";

/** Short stable id fragment from some strings: first 8 hex characters of their SHA-256. */
export function shortHash(...parts: readonly string[]): string {
  return sha256Hex(parts.join("\u0001")).slice(0, 8);
}

export function emptyTables(): TableRows {
  return {
    list_entry: [],
    list_alias: [],
    list_identifier: [],
    list_dob: [],
    list_country: [],
    list_program: [],
    list_relationship: [],
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

const bySortKey = <T>(rows: readonly T[] | undefined, key: (row: T) => string): T[] =>
  [...(rows ?? [])].sort((a, b) => key(a).localeCompare(key(b)));

/**
 * Hash of everything known about each entry, independent of row order, of row ids and of the
 * snapshot the entry came from. A changed hash means something about the entry changed.
 * Computed in one pass over the tables.
 */
export function computeContentHashes(tables: TableRows): Map<string, string> {
  const aliases = groupBy(tables.list_alias, (r) => r.entry_id);
  const identifiers = groupBy(tables.list_identifier, (r) => r.entry_id);
  const dobs = groupBy(tables.list_dob, (r) => r.entry_id);
  const countries = groupBy(tables.list_country, (r) => r.entry_id);
  const programs = groupBy(tables.list_program, (r) => r.entry_id);
  const relationships = groupBy(tables.list_relationship, (r) => r.from_entry_id);

  const out = new Map<string, string>();
  for (const entry of tables.list_entry) {
    const { snapshot_id: _snapshot, content_hash: _hash, ...core } = entry;
    out.set(
      entry.entry_id,
      hashValue({
        core,
        aliases: bySortKey(aliases.get(entry.entry_id), (r) => `${r.alias_type}|${r.alias_name}`).map(
          ({ alias_id: _id, ...r }) => r,
        ),
        identifiers: bySortKey(identifiers.get(entry.entry_id), (r) => `${r.id_type}|${r.id_number}`).map(
          ({ identifier_id: _id, ...r }) => r,
        ),
        dobs: bySortKey(
          dobs.get(entry.entry_id),
          (r) => `${r.dob_value ?? ""}|${r.range_from ?? ""}|${r.range_to ?? ""}`,
        ).map(({ dob_id: _id, ...r }) => r),
        countries: bySortKey(
          countries.get(entry.entry_id),
          (r) => `${r.role}|${r.country_iso2 ?? ""}|${r.country_name ?? ""}|${r.place ?? ""}`,
        ).map(({ country_link_id: _id, ...r }) => r),
        programs: bySortKey(programs.get(entry.entry_id), (r) => r.program).map(({ program_id: _id, ...r }) => r),
        relationships: bySortKey(relationships.get(entry.entry_id), (r) => `${r.relation_type}|${r.to_entry_id}`).map(
          ({ relationship_id: _id, ...r }) => r,
        ),
      }),
    );
  }
  return out;
}

/** Fill in `content_hash` on every entry. */
export function sealEntries(tables: TableRows): void {
  const hashes = computeContentHashes(tables);
  for (const entry of tables.list_entry) {
    const hash = hashes.get(entry.entry_id);
    if (hash) entry.content_hash = hash;
  }
}

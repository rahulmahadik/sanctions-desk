import { isIso2, iso2FromName, USER_ASSIGNED_CODES } from "./countries.js";
import { docTypeToIdType } from "./identifiers.js";
import {
  emptyTables,
  type ListAliasRow,
  type ListCountryRow,
  type ListIdentifierRow,
  type ListRelationshipRow,
  type PartyKind,
  shortHash,
  type TableRows,
} from "./model.js";
import { describeWindow, detectScript, normaliseName, type YMD } from "./text.js";
import type { XmlNode } from "./xml.js";
import { child, children, parseXmlFile, parseXmlString, textOf } from "./xml.js";

/**
 * Parser for OFAC's "Advanced XML" files (SDN_ADVANCED.XML and CONS_ADVANCED.XML).
 *
 * The files are large, so they are read as a stream. They are laid out as reference tables, then
 * locations, identity documents, the parties themselves, the relationships between parties, and
 * finally the sanctions entries that put a party on a list with its programs.
 */

export interface OfacOptions {
  /** Entry id prefix, so SDN and consolidated entries share one id space (the same party keeps one id). */
  idPrefix?: string;
  snapshotId: string;
  /** Name of the list a sanctions entry belongs to is read from the file; this is the fallback. */
  sanctionsList: string;
}

export interface OfacParseResult {
  tables: TableRows;
  issuedOn: string | null;
  stats: {
    parties: number;
    entries: number;
    skippedParties: number;
    ignoredFeatures: Record<string, number>;
    unmappedCountries: number;
  };
}

// ---- reference tables ----------------------------------------------------------------------

/** Names of the reference-table items we read, mapped to the lookup they fill. */
const REFERENCE_LOOKUPS = {
  AliasType: "aliasTypes",
  FeatureType: "featureTypes",
  IDRegDocType: "docTypes",
  NamePartType: "namePartTypes",
  PartySubType: "partySubTypes",
  List: "lists",
  RelationType: "relationTypes",
  LocPartType: "locPartTypes",
} as const;

const RECORD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(REFERENCE_LOOKUPS),
  "Country",
  "DateOfIssue",
  "Location",
  "IDRegDocument",
  "DistinctParty",
  "ProfileRelationship",
  "SanctionsEntry",
]);

class References {
  readonly aliasTypes = new Map<string, string>();
  readonly featureTypes = new Map<string, string>();
  readonly docTypes = new Map<string, string>();
  readonly namePartTypes = new Map<string, string>();
  readonly partySubTypes = new Map<string, string>();
  readonly lists = new Map<string, string>();
  readonly relationTypes = new Map<string, string>();
  readonly locPartTypes = new Map<string, string>();
  readonly countries = new Map<string, { iso2: string; name: string }>();
  readonly locations = new Map<string, Location>();

  /** Store one reference-table item. Returns false when the node is not one. */
  register(node: XmlNode): boolean {
    const id = node.attrs.ID ?? "";
    if (node.name === "Country") {
      this.countries.set(id, { iso2: node.attrs.ISO2 ?? "", name: node.text });
      return true;
    }
    const lookup = REFERENCE_LOOKUPS[node.name as keyof typeof REFERENCE_LOOKUPS];
    if (!lookup) return false;
    this[lookup].set(id, node.text);
    return true;
  }
}

interface Location {
  countryIso2: string | null;
  countryName: string | null;
  place: string | null;
}

interface DocumentRecord {
  typeId: string;
  identityId: string;
  issuedByCountryId: string | null;
  number: string;
  invalid: boolean;
}

interface PartyAlias {
  /** The first spelling of the primary alias: the entry's main name. */
  primary: boolean;
  /** Every spelling of the primary alias. */
  ofPrimaryAlias: boolean;
  typeId: string;
  lowQuality: boolean;
  name: string;
}

interface Party {
  profileId: string;
  subTypeId: string;
  aliases: PartyAlias[];
  features: XmlNode[];
  identityIds: string[];
  remarks: string | null;
}

interface Entry {
  profileId: string;
  listName: string;
  listedOn: string | null;
  programs: string[];
}

// ---- small readers -------------------------------------------------------------------------

function ymd(node: XmlNode | undefined): YMD | null {
  if (!node) return null;
  const year = Number(textOf(node, "Year"));
  const month = Number(textOf(node, "Month"));
  const day = Number(textOf(node, "Day"));
  if (![year, month, day].every((n) => Number.isInteger(n) && n > 0)) return null;
  return { year, month, day };
}

function iso(d: YMD): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** The window of possible days that an OFAC DatePeriod describes. */
function periodWindow(period: XmlNode): { from: YMD; to: YMD; approximate: boolean } | null {
  const start = child(period, "Start");
  const end = child(period, "End");
  const from = ymd(child(start, "From"));
  const to = ymd(child(end, "To"));
  if (!from || !to) return null;
  return { from, to, approximate: start?.attrs.Approximate === "true" || end?.attrs.Approximate === "true" };
}

function validIso(code: string | null | undefined): string | null {
  if (!code) return null;
  return isIso2(code) || USER_ASSIGNED_CODES.has(code) ? code : null;
}

function aliasTypeOf(typeName: string, lowQuality: boolean): ListAliasRow["alias_type"] {
  if (lowQuality) return "low_quality";
  const t = typeName.toLowerCase();
  if (t.startsWith("f.k.a")) return "fka";
  if (t.startsWith("n.k.a")) return "nka";
  return "aka";
}

/**
 * Join the name parts of one spelling into a display name. OFAC prints the family name first
 * ("LAST, First"); we write the family name last so the name reads naturally.
 */
function assembleName(parts: readonly string[], types: readonly string[]): string {
  const family = parts.filter((_, i) => types[i] === "Last Name");
  const rest = parts.filter((_, i) => types[i] !== "Last Name");
  return family.length > 0 && rest.length > 0 ? [...rest, ...family].join(" ") : parts.join(" ");
}

function snake(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---- reading records -----------------------------------------------------------------------

function readLocation(node: XmlNode, refs: References): Location {
  const countryId = child(node, "LocationCountry")?.attrs.CountryID;
  const country = countryId ? refs.countries.get(countryId) : undefined;
  const parts: string[] = [];
  for (const part of children(node, "LocationPart")) {
    const type = refs.locPartTypes.get(part.attrs.LocPartTypeID ?? "") ?? "";
    if (/postal/i.test(type)) continue;
    const value = textOf(child(part, "LocationPartValue"), "Value");
    if (value) parts.push(value);
  }
  return {
    countryIso2: country?.iso2 ?? null,
    countryName: country?.name ?? null,
    place: parts.length > 0 ? parts.join(", ") : null,
  };
}

function readDocument(node: XmlNode): DocumentRecord | null {
  const number = textOf(node, "IDRegistrationNo");
  if (!number) return null;
  return {
    typeId: node.attrs.IDRegDocTypeID ?? "",
    identityId: node.attrs.IdentityID ?? "",
    issuedByCountryId: node.attrs["IssuedBy-CountryID"] ?? null,
    number,
    invalid: node.attrs.ValidityID !== undefined && node.attrs.ValidityID !== "1",
  };
}

/** Name-part group ids of one identity, mapped to their part type ("Last Name", "First Name", ...). */
function namePartGroupTypes(identity: XmlNode, refs: References): Map<string, string> {
  const out = new Map<string, string>();
  for (const master of children(child(identity, "NamePartGroups"), "MasterNamePartGroup")) {
    const group = child(master, "NamePartGroup");
    if (group) out.set(group.attrs.ID ?? "", refs.namePartTypes.get(group.attrs.NamePartTypeID ?? "") ?? "");
  }
  return out;
}

/** One spelling of an alias: its name parts joined in reading order. */
function readSpelling(documentedName: XmlNode, groupTypes: Map<string, string>): string | null {
  const parts: string[] = [];
  const types: string[] = [];
  for (const part of children(documentedName, "DocumentedNamePart")) {
    const value = child(part, "NamePartValue");
    if (!value?.text) continue;
    parts.push(value.text);
    types.push(groupTypes.get(value.attrs.NamePartGroupID ?? "") ?? "");
  }
  return parts.length > 0 ? assembleName(parts, types) : null;
}

function readAliases(identity: XmlNode, refs: References): PartyAlias[] {
  const groupTypes = namePartGroupTypes(identity, refs);
  const out: PartyAlias[] = [];
  for (const alias of children(identity, "Alias")) {
    // One alias can be written in several scripts: each DocumentedName is one spelling of it.
    children(alias, "DocumentedName").forEach((documentedName, spelling) => {
      const name = readSpelling(documentedName, groupTypes);
      if (name === null) return;
      out.push({
        primary: alias.attrs.Primary === "true" && spelling === 0,
        ofPrimaryAlias: alias.attrs.Primary === "true",
        typeId: alias.attrs.AliasTypeID ?? "",
        lowQuality: alias.attrs.LowQuality === "true",
        name,
      });
    });
  }
  return out;
}

function readParty(node: XmlNode, refs: References): Party | null {
  const profile = child(node, "Profile");
  if (!profile) return null;
  const identities = children(profile, "Identity");
  return {
    profileId: profile.attrs.ID ?? node.attrs.FixedRef ?? "",
    subTypeId: profile.attrs.PartySubTypeID ?? "",
    aliases: identities.flatMap((identity) => readAliases(identity, refs)),
    features: children(profile, "Feature"),
    identityIds: identities.map((i) => i.attrs.ID ?? ""),
    remarks: textOf(node, "Comment") ?? null,
  };
}

function readEntry(node: XmlNode, refs: References, fallbackList: string): Entry {
  const programs: string[] = [];
  for (const measure of children(node, "SanctionsMeasure")) {
    const program = textOf(measure, "Comment");
    if (program && !programs.includes(program)) programs.push(program);
  }
  const days = children(node, "EntryEvent")
    .map((event) => ymd(child(event, "Date")))
    .filter((d): d is YMD => d !== null)
    .map(iso)
    .sort();
  return {
    profileId: node.attrs.ProfileID ?? "",
    listName: refs.lists.get(node.attrs.ListID ?? "") ?? fallbackList,
    listedOn: days[0] ?? null,
    programs,
  };
}

function kindOf(party: Party, refs: References): PartyKind {
  const subType = refs.partySubTypes.get(party.subTypeId) ?? "";
  if (/vessel/i.test(subType)) return "vessel";
  if (/aircraft/i.test(subType)) return "aircraft";
  // The published reference tables define sub type 3 as an entity and 4 as an individual.
  if (party.subTypeId === "3") return "entity";
  if (party.subTypeId === "4") return "individual";
  return "other";
}

// ---- features: birth dates, countries, identifiers ----------------------------------------

interface FeatureContext {
  tables: TableRows;
  entryId: string;
  refs: References;
  stats: OfacParseResult["stats"];
  typeName: string;
}

type FeatureHandler = (ctx: FeatureContext, version: XmlNode) => boolean;

function locationOf(ctx: FeatureContext, version: XmlNode): Location | undefined {
  const id = child(version, "VersionLocation")?.attrs.LocationID;
  return id ? ctx.refs.locations.get(id) : undefined;
}

function pushCountry(
  ctx: FeatureContext,
  role: ListCountryRow["role"],
  iso2: string | null,
  name: string | null,
  place: string | null,
): void {
  const valid = validIso(iso2);
  if (iso2 !== null && valid === null) ctx.stats.unmappedCountries += 1;
  ctx.tables.list_country.push({
    country_link_id: `${ctx.entryId}-c-${shortHash(role, valid ?? "", name ?? "", place ?? "")}`,
    entry_id: ctx.entryId,
    country_iso2: valid,
    country_name: name,
    role,
    place,
  });
}

function pushIdentifier(ctx: FeatureContext, idType: ListIdentifierRow["id_type"], number: string, note: string): void {
  ctx.tables.list_identifier.push({
    identifier_id: `${ctx.entryId}-i-${shortHash(idType, number, "")}`,
    entry_id: ctx.entryId,
    id_type: idType,
    id_number: number,
    issuing_country: null,
    note,
  });
}

const birthdate: FeatureHandler = (ctx, version) => {
  const period = child(version, "DatePeriod");
  const window = period ? periodWindow(period) : null;
  if (!window) return true;
  const d = describeWindow(window.from, window.to);
  ctx.tables.list_dob.push({
    dob_id: `${ctx.entryId}-d-${shortHash(d.value ?? "", d.rangeFrom ?? "", d.rangeTo ?? "", String(window.approximate))}`,
    entry_id: ctx.entryId,
    dob_value: d.value,
    dob_precision: d.precision,
    range_from: d.rangeFrom,
    range_to: d.rangeTo,
    is_approximate: window.approximate,
  });
  return true;
};

const countryFeature =
  (role: ListCountryRow["role"]): FeatureHandler =>
  (ctx, version) => {
    const location = locationOf(ctx, version);
    if (location) {
      pushCountry(ctx, role, location.countryIso2, location.countryName, location.place);
      return true;
    }
    const detail = textOf(version, "VersionDetail");
    if (!detail) return false;
    pushCountry(ctx, role, iso2FromName(detail) ?? null, detail, null);
    return true;
  };

const placeOfBirth: FeatureHandler = (ctx, version) => {
  const location = locationOf(ctx, version);
  const place = location?.place ?? textOf(version, "VersionDetail") ?? null;
  if (!location && !place) return true;
  pushCountry(ctx, "place_of_birth", location?.countryIso2 ?? null, location?.countryName ?? null, place);
  return true;
};

const addressLocation: FeatureHandler = (ctx, version) => {
  const location = locationOf(ctx, version);
  if (location) pushCountry(ctx, "address", location.countryIso2, location.countryName, location.place);
  return true;
};

const detailIdentifier =
  (idType: ListIdentifierRow["id_type"]): FeatureHandler =>
  (ctx, version) => {
    const detail = textOf(version, "VersionDetail");
    if (detail) pushIdentifier(ctx, idType, detail, ctx.typeName);
    return true;
  };

/** Feature types we turn into rows, by lower-case name. Everything else is counted and ignored. */
const FEATURE_HANDLERS: Readonly<Record<string, FeatureHandler>> = {
  birthdate,
  "place of birth": placeOfBirth,
  location: addressLocation,
  "nationality country": countryFeature("nationality"),
  "citizenship country": countryFeature("citizenship"),
  "nationality of registration": countryFeature("registered_in"),
  "registration country": countryFeature("registered_in"),
  "vessel flag": countryFeature("other"),
  "former vessel flag": countryFeature("other"),
  "other vessel flag": countryFeature("other"),
  "swift/bic": detailIdentifier("swift_bic"),
  "vessel call sign": detailIdentifier("vessel_imo"),
  "aircraft tail number": detailIdentifier("aircraft_id"),
  "previous aircraft tail number": detailIdentifier("aircraft_id"),
  "d-u-n-s number": detailIdentifier("registration"),
};

// ---- building rows -------------------------------------------------------------------------

function addAliasRows(tables: TableRows, party: Party, entryId: string, refs: References): PartyAlias | undefined {
  const primary = party.aliases.find((a) => a.primary) ?? party.aliases[0];
  const seen = new Set<string>();
  for (const alias of party.aliases) {
    const type = refs.aliasTypes.get(alias.typeId) ?? "";
    const aliasType = alias.ofPrimaryAlias ? "primary" : aliasTypeOf(type, alias.lowQuality);
    const key = `${aliasType}|${alias.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.list_alias.push({
      alias_id: `${entryId}-a-${shortHash(aliasType, alias.name)}`,
      entry_id: entryId,
      alias_name: alias.name,
      alias_type: aliasType,
      script: detectScript(alias.name),
      name_normalised: normaliseName(alias.name),
      is_primary: alias === primary,
      is_strong: !alias.lowQuality,
    });
  }
  return primary;
}

function addIdentifierRows(
  tables: TableRows,
  party: Party,
  entryId: string,
  refs: References,
  documents: Map<string, DocumentRecord[]>,
): void {
  for (const identityId of party.identityIds) {
    for (const doc of documents.get(identityId) ?? []) {
      const typeName = refs.docTypes.get(doc.typeId) ?? "Document";
      const country = doc.issuedByCountryId ? refs.countries.get(doc.issuedByCountryId) : undefined;
      const idType = docTypeToIdType(typeName);
      tables.list_identifier.push({
        identifier_id: `${entryId}-i-${shortHash(idType, doc.number, country?.iso2 ?? "")}`,
        entry_id: entryId,
        id_type: idType,
        id_number: doc.number,
        issuing_country: validIso(country?.iso2),
        note: doc.invalid ? `${typeName} (marked fraudulent)` : typeName,
      });
    }
  }
}

function addFeatureRows(
  tables: TableRows,
  party: Party,
  entryId: string,
  refs: References,
  stats: OfacParseResult["stats"],
): void {
  for (const feature of party.features) {
    const typeName = refs.featureTypes.get(feature.attrs.FeatureTypeID ?? "") ?? "";
    const handler = FEATURE_HANDLERS[typeName.toLowerCase()];
    for (const version of children(feature, "FeatureVersion")) {
      const handled = handler?.({ tables, entryId, refs, stats, typeName }, version) ?? false;
      if (!handled) stats.ignoredFeatures[typeName] = (stats.ignoredFeatures[typeName] ?? 0) + 1;
    }
  }
}

function addParty(
  tables: TableRows,
  party: Party,
  entry: Entry,
  entryId: string,
  refs: References,
  documents: Map<string, DocumentRecord[]>,
  stats: OfacParseResult["stats"],
  snapshotId: string,
): void {
  const primary = addAliasRows(tables, party, entryId, refs);
  if (!primary) return;
  tables.list_entry.push({
    entry_id: entryId,
    list_id: "OFAC",
    source_uid: party.profileId,
    party_kind: kindOf(party, refs),
    primary_name: primary.name,
    primary_name_script: detectScript(primary.name),
    name_normalised: normaliseName(primary.name),
    listed_on: entry.listedOn,
    sanctions_list: entry.listName,
    remarks: party.remarks,
    snapshot_id: snapshotId,
    content_hash: "0".repeat(64),
  });
  addFeatureRows(tables, party, entryId, refs, stats);
  addIdentifierRows(tables, party, entryId, refs, documents);
  for (const program of entry.programs) {
    tables.list_program.push({ program_id: `${entryId}-p-${shortHash(program)}`, entry_id: entryId, program });
  }
}

function groupDocuments(documents: readonly DocumentRecord[]): Map<string, DocumentRecord[]> {
  const out = new Map<string, DocumentRecord[]>();
  for (const doc of documents) {
    const list = out.get(doc.identityId);
    if (list) list.push(doc);
    else out.set(doc.identityId, [doc]);
  }
  return out;
}

function relationshipRow(node: XmlNode, prefix: string, refs: References): ListRelationshipRow {
  const from = node.attrs["From-ProfileID"] ?? "";
  const to = node.attrs["To-ProfileID"] ?? "";
  const relation = snake(refs.relationTypes.get(node.attrs.RelationTypeID ?? "") ?? "related");
  return {
    relationship_id: `${prefix}-rel-${node.attrs.ID ?? shortHash(from, to, relation)}`,
    from_entry_id: `${prefix}-${from}`,
    to_entry_id: `${prefix}-${to}`,
    relation_type: relation,
    is_former: node.attrs.Former === "true",
  };
}

// ---- the parse -----------------------------------------------------------------------------

export function parseOfacString(xml: string, options: OfacOptions): OfacParseResult {
  const parse = new OfacParse(options);
  parseXmlString(xml, parse.streamOptions());
  return parse.finish();
}

export async function parseOfacFile(path: string, options: OfacOptions): Promise<OfacParseResult> {
  const parse = new OfacParse(options);
  await parseXmlFile(path, parse.streamOptions());
  return parse.finish();
}

class OfacParse {
  private readonly refs = new References();
  private readonly documents: DocumentRecord[] = [];
  private readonly parties: Party[] = [];
  private readonly relationships: XmlNode[] = [];
  private readonly entries: Entry[] = [];
  private readonly handlers: Record<string, (node: XmlNode) => void>;
  private issuedOn: string | null = null;
  private rootSeen = false;

  constructor(private readonly options: OfacOptions) {
    this.handlers = {
      DateOfIssue: (n) => {
        const d = ymd(n);
        if (d) this.issuedOn = iso(d);
      },
      Location: (n) => this.refs.locations.set(n.attrs.ID ?? "", readLocation(n, this.refs)),
      IDRegDocument: (n) => {
        const doc = readDocument(n);
        if (doc) this.documents.push(doc);
      },
      DistinctParty: (n) => {
        const party = readParty(n, this.refs);
        if (party) this.parties.push(party);
      },
      ProfileRelationship: (n) => this.relationships.push(n),
      SanctionsEntry: (n) => this.entries.push(readEntry(n, this.refs, this.options.sanctionsList)),
    };
  }

  streamOptions() {
    return {
      recordNames: RECORD_NAMES,
      onRoot: () => {
        this.rootSeen = true;
      },
      onRecord: (node: XmlNode) => {
        if (!this.refs.register(node)) this.handlers[node.name]?.(node);
      },
    };
  }

  finish(): OfacParseResult {
    if (!this.rootSeen) throw new Error("not an OFAC advanced XML file: no root element");
    const prefix = this.options.idPrefix ?? "OFAC";
    const tables = emptyTables();
    const stats: OfacParseResult["stats"] = {
      parties: this.parties.length,
      entries: this.entries.length,
      skippedParties: 0,
      ignoredFeatures: {},
      unmappedCountries: 0,
    };
    const entryByProfile = new Map<string, Entry>();
    for (const e of this.entries) if (!entryByProfile.has(e.profileId)) entryByProfile.set(e.profileId, e);
    const documents = groupDocuments(this.documents);

    for (const party of this.parties) {
      const entry = entryByProfile.get(party.profileId);
      if (!entry) {
        stats.skippedParties += 1;
        continue;
      }
      addParty(
        tables,
        party,
        entry,
        `${prefix}-${party.profileId}`,
        this.refs,
        documents,
        stats,
        this.options.snapshotId,
      );
    }

    for (const rel of this.relationships) {
      if (entryByProfile.has(rel.attrs["From-ProfileID"] ?? "")) {
        tables.list_relationship.push(relationshipRow(rel, prefix, this.refs));
      }
    }
    return { tables, issuedOn: this.issuedOn, stats };
  }
}

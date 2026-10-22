import { iso2FromName } from "./countries.js";
import { docTypeToIdType } from "./identifiers.js";
import { emptyTables, type ListAliasRow, type ListCountryRow, shortHash, type TableRows } from "./model.js";
import { daysInMonth, describeWindow, detectScript, normaliseName } from "./text.js";
import { children, parseXmlFile, parseXmlString, textOf, type XmlNode } from "./xml.js";

/**
 * Parser for the UN Security Council consolidated list (consolidated.xml).
 *
 * Individuals and entities are separate record types with the same layout. Countries are written as
 * names, which are mapped to ISO codes; a name we cannot map keeps its text and gets no code.
 */

export interface UnOptions {
  snapshotId: string;
  sanctionsList: string;
}

export interface UnParseResult {
  tables: TableRows;
  issuedOn: string | null;
  stats: { individuals: number; entities: number; unmappedCountries: number };
}

const RECORDS = new Set(["INDIVIDUAL", "ENTITY"]);

export function parseUnString(xml: string, options: UnOptions): UnParseResult {
  const ctx = new UnContext(options);
  parseXmlString(xml, ctx.streamOptions());
  return ctx.finish();
}

export async function parseUnFile(path: string, options: UnOptions): Promise<UnParseResult> {
  const ctx = new UnContext(options);
  await parseXmlFile(path, ctx.streamOptions());
  return ctx.finish();
}

const isoDate = (text: string | undefined): string | null => (text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null);

const joinPresent = (parts: ReadonlyArray<string | undefined>): string | null =>
  parts.filter(Boolean).join(", ") || null;

/** The date of birth a UN record states, as a day, a whole year or a range of years. */
function describeUnDob(dob: XmlNode): ReturnType<typeof describeWindow> | null {
  const date = textOf(dob, "DATE");
  if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
    const valid = m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
    return valid ? describeWindow({ year: y, month: m, day: d }, { year: y, month: m, day: d }) : null;
  }
  const year = Number(textOf(dob, "YEAR"));
  if (Number.isInteger(year) && year > 0) {
    return describeWindow({ year, month: 1, day: 1 }, { year, month: 12, day: 31 });
  }
  const fromYear = Number(textOf(dob, "FROM_YEAR"));
  const toYear = Number(textOf(dob, "TO_YEAR"));
  if (Number.isInteger(fromYear) && Number.isInteger(toYear) && fromYear > 0 && toYear >= fromYear) {
    return describeWindow({ year: fromYear, month: 1, day: 1 }, { year: toYear, month: 12, day: 31 });
  }
  return null;
}

class UnContext {
  private readonly tables = emptyTables();
  private issuedOn: string | null = null;
  private individuals = 0;
  private entities = 0;
  private unmapped = 0;
  private rootSeen = false;

  constructor(private readonly options: UnOptions) {}

  streamOptions() {
    return {
      recordNames: RECORDS,
      onRoot: (_name: string, attrs: Record<string, string>) => {
        this.rootSeen = true;
        this.issuedOn = isoDate(attrs.dateGenerated?.slice(0, 10)) ?? null;
      },
      onRecord: (node: XmlNode) => this.onRecord(node),
    };
  }

  finish(): UnParseResult {
    if (!this.rootSeen) throw new Error("not a UN consolidated list: no root element");
    return {
      tables: this.tables,
      issuedOn: this.issuedOn,
      stats: { individuals: this.individuals, entities: this.entities, unmappedCountries: this.unmapped },
    };
  }

  private onRecord(node: XmlNode): void {
    const individual = node.name === "INDIVIDUAL";
    const reference = textOf(node, "REFERENCE_NUMBER") ?? textOf(node, "DATAID");
    if (!reference) return;
    const entryId = `UN-${reference}`;
    const names = ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"]
      .map((t) => textOf(node, t))
      .filter(Boolean) as string[];
    if (names.length === 0) return;
    const primaryName = names.join(" ");
    if (individual) this.individuals += 1;
    else this.entities += 1;

    const script = detectScript(primaryName);
    this.tables.list_entry.push({
      entry_id: entryId,
      list_id: "UN",
      source_uid: reference,
      party_kind: individual ? "individual" : "entity",
      primary_name: primaryName,
      primary_name_script: script,
      name_normalised: normaliseName(primaryName),
      listed_on: isoDate(textOf(node, "LISTED_ON")) ?? null,
      sanctions_list: this.options.sanctionsList,
      remarks: textOf(node, "COMMENTS1") ?? null,
      snapshot_id: this.options.snapshotId,
      content_hash: "0".repeat(64),
    });

    this.tables.list_alias.push({
      alias_id: `${entryId}-a-${shortHash("primary", primaryName)}`,
      entry_id: entryId,
      alias_name: primaryName,
      alias_type: "primary",
      script,
      name_normalised: normaliseName(primaryName),
      is_primary: true,
      is_strong: true,
    });

    const prefix = individual ? "INDIVIDUAL" : "ENTITY";
    this.addAliases(entryId, node, prefix, primaryName);
    this.addDobs(entryId, node);
    this.addPlacesAndNationalities(entryId, node, prefix);
    this.addDocuments(entryId, node);

    const program = textOf(node, "UN_LIST_TYPE");
    if (program) {
      this.tables.list_program.push({ program_id: `${entryId}-p-${shortHash(program)}`, entry_id: entryId, program });
    }
  }

  private addAliases(entryId: string, node: XmlNode, prefix: string, primaryName: string): void {
    const seen = new Set<string>([`primary|${primaryName}`]);
    for (const alias of children(node, `${prefix}_ALIAS`)) {
      const name = textOf(alias, "ALIAS_NAME");
      if (!name) continue;
      const quality = (textOf(alias, "QUALITY") ?? "").toLowerCase();
      const aliasType: ListAliasRow["alias_type"] =
        quality === "low" ? "low_quality" : quality === "f.k.a." ? "fka" : "aka";
      const key = `${aliasType}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const script = detectScript(name);
      this.tables.list_alias.push({
        alias_id: `${entryId}-a-${shortHash(aliasType, name)}`,
        entry_id: entryId,
        alias_name: name,
        alias_type: aliasType,
        script,
        name_normalised: normaliseName(name),
        is_primary: false,
        is_strong: aliasType !== "low_quality",
      });
    }
  }

  private addDobs(entryId: string, node: XmlNode): void {
    for (const dob of children(node, "INDIVIDUAL_DATE_OF_BIRTH")) {
      const described = describeUnDob(dob);
      if (!described) continue;
      const approximate = (textOf(dob, "TYPE_OF_DATE") ?? "").toUpperCase().startsWith("APPROX");
      this.tables.list_dob.push({
        dob_id: `${entryId}-d-${shortHash(described.value ?? "", described.rangeFrom ?? "", described.rangeTo ?? "", String(approximate))}`,
        entry_id: entryId,
        dob_value: described.value,
        dob_precision: described.precision,
        range_from: described.rangeFrom,
        range_to: described.rangeTo,
        is_approximate: approximate,
      });
    }
  }

  private addPlacesAndNationalities(entryId: string, node: XmlNode, prefix: string): void {
    this.addNationalities(entryId, node);
    this.addBirthPlaces(entryId, node);
    this.addAddresses(entryId, node, prefix);
  }

  private addNationalities(entryId: string, node: XmlNode): void {
    for (const nationality of children(node, "NATIONALITY")) {
      for (const value of children(nationality, "VALUE")) {
        if (value.text) this.pushCountry(entryId, "nationality", value.text, null);
      }
    }
  }

  private addBirthPlaces(entryId: string, node: XmlNode): void {
    for (const pob of children(node, "INDIVIDUAL_PLACE_OF_BIRTH")) {
      const country = textOf(pob, "COUNTRY");
      const place = joinPresent([textOf(pob, "CITY"), textOf(pob, "STATE_PROVINCE")]);
      if (country || place) this.pushCountry(entryId, "place_of_birth", country ?? null, place);
    }
  }

  private addAddresses(entryId: string, node: XmlNode, prefix: string): void {
    for (const address of children(node, `${prefix}_ADDRESS`)) {
      const country = textOf(address, "COUNTRY");
      const place = joinPresent([
        textOf(address, "STREET"),
        textOf(address, "CITY"),
        textOf(address, "STATE_PROVINCE"),
        textOf(address, "NOTE"),
      ]);
      if (country || place) this.pushCountry(entryId, "address", country ?? null, place);
    }
  }

  private pushCountry(entryId: string, role: ListCountryRow["role"], name: string | null, place: string | null): void {
    const iso2 = name ? (iso2FromName(name) ?? null) : null;
    if (name && iso2 === null) this.unmapped += 1;
    this.tables.list_country.push({
      country_link_id: `${entryId}-c-${shortHash(role, iso2 ?? "", name ?? "", place ?? "")}`,
      entry_id: entryId,
      country_iso2: iso2,
      country_name: name,
      role,
      place,
    });
  }

  private addDocuments(entryId: string, node: XmlNode): void {
    for (const doc of children(node, "INDIVIDUAL_DOCUMENT")) {
      const number = textOf(doc, "NUMBER");
      if (!number) continue;
      const typeName = textOf(doc, "TYPE_OF_DOCUMENT") ?? textOf(doc, "TYPE_OF_DOCUMENT2") ?? "Document";
      const country = textOf(doc, "ISSUING_COUNTRY") ?? textOf(doc, "COUNTRY_OF_ISSUE");
      const iso2 = country ? (iso2FromName(country) ?? null) : null;
      if (country && iso2 === null) this.unmapped += 1;
      const idType = docTypeToIdType(typeName);
      this.tables.list_identifier.push({
        identifier_id: `${entryId}-i-${shortHash(idType, number, iso2 ?? "")}`,
        entry_id: entryId,
        id_type: idType,
        id_number: number,
        issuing_country: iso2,
        note: typeName,
      });
    }
  }
}

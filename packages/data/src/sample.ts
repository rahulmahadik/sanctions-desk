import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import {
  emptyTables,
  type ListEntryRow,
  type ListSource,
  type NormalisedSnapshot,
  shortHash,
  TABLE_NAMES,
  type TableName,
  type TableRows,
} from "./model.js";
import type { SampleConfig } from "./sources.js";

/**
 * A small, deterministic subset of the normalised public lists. It keeps the shapes that matter for
 * screening: non-Latin names, partial dates of birth, companies, ownership links and sanctioned jurisdictions.
 */

export interface ListSample {
  tables: TableRows;
  manifest: SampleManifest;
}

export interface SampleManifest {
  label: string;
  seed: string;
  snapshots: Array<{ snapshot_id: string; list_id: ListSource; issued_on: string | null; source_url: string }>;
  counts: Record<string, number>;
  selected_by_rule: Record<string, number>;
}

type Rule = keyof SampleConfig["quotas"] | "ownership";

interface Index {
  aliasScripts: Map<string, Set<string>>;
  dobPrecisions: Map<string, Set<string>>;
  countries: Map<string, Set<string>>;
}

function indexOf(tables: TableRows): Index {
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  const index: Index = { aliasScripts: new Map(), dobPrecisions: new Map(), countries: new Map() };
  for (const a of tables.list_alias) add(index.aliasScripts, a.entry_id, a.script);
  for (const d of tables.list_dob) add(index.dobPrecisions, d.entry_id, d.dob_precision);
  for (const c of tables.list_country) if (c.country_iso2) add(index.countries, c.entry_id, c.country_iso2);
  return index;
}

const JURISDICTIONS = new Set(["CU", "IR", "KP", "SY", "RU", "VE", "MM"]);

function matches(rule: Exclude<Rule, "ownership">, entry: ListEntryRow, index: Index): boolean {
  const scripts = index.aliasScripts.get(entry.entry_id) ?? new Set<string>();
  const precisions = index.dobPrecisions.get(entry.entry_id) ?? new Set<string>();
  const countries = index.countries.get(entry.entry_id) ?? new Set<string>();
  const person = entry.party_kind === "individual";
  switch (rule) {
    case "individualNonLatin":
      return (
        person && entry.primary_name_script === "Latin" && [...scripts].some((s) => s !== "Latin" && s !== "Mixed")
      );
    case "individualPartialDob":
      return person && [...precisions].some((p) => p !== "day");
    case "individualFullDob":
      return person && precisions.has("day");
    case "entity":
      return entry.party_kind === "entity";
    case "jurisdiction":
      return [...countries].some((c) => JURISDICTIONS.has(c));
    case "vessel":
      return entry.party_kind === "vessel";
  }
}

const RULE_ORDER: Array<Exclude<Rule, "ownership">> = [
  "individualNonLatin",
  "individualPartialDob",
  "individualFullDob",
  "entity",
  "jurisdiction",
  "vessel",
];

const rankOf = (seed: string) => (id: string) => shortHash(seed, id);

/** Entries chosen by the category rules, per list, in a repeatable order. */
function pickByRules(
  snapshot: NormalisedSnapshot,
  config: SampleConfig,
  chosen: Set<string>,
  byRule: Record<string, number>,
) {
  const rank = rankOf(config.seed);
  const list = snapshot.meta.list_id;
  const index = indexOf(snapshot.tables);
  const ordered = [...snapshot.tables.list_entry].sort((a, b) => rank(a.entry_id).localeCompare(rank(b.entry_id)));
  for (const rule of RULE_ORDER) {
    const quota = config.quotas[rule][list] ?? 0;
    const picked = ordered.filter((e) => !chosen.has(e.entry_id) && matches(rule, e, index)).slice(0, quota);
    for (const entry of picked) chosen.add(entry.entry_id);
    byRule[rule] = (byRule[rule] ?? 0) + picked.length;
  }
}

/** Ownership links whose two ends both exist; both ends are kept. */
function pickOwnershipLinks(
  snapshot: NormalisedSnapshot,
  config: SampleConfig,
  chosen: Set<string>,
  byRule: Record<string, number>,
) {
  const rank = rankOf(config.seed);
  const known = new Set(snapshot.tables.list_entry.map((e) => e.entry_id));
  const wanted = snapshot.meta.list_id === "OFAC" ? config.ownershipLinks : 0;
  const links = snapshot.tables.list_relationship
    .filter(
      (r) => r.relation_type === "owned_or_controlled_by" && known.has(r.from_entry_id) && known.has(r.to_entry_id),
    )
    .sort((a, b) => rank(a.relationship_id).localeCompare(rank(b.relationship_id)))
    .slice(0, wanted);
  for (const link of links) {
    chosen.add(link.from_entry_id);
    chosen.add(link.to_entry_id);
  }
  byRule.ownership = (byRule.ownership ?? 0) + links.length;
}

function keeps(name: TableName, row: object, chosen: ReadonlySet<string>): boolean {
  const r = row as Record<string, string>;
  if (name === "list_relationship") return chosen.has(r.from_entry_id as string) && chosen.has(r.to_entry_id as string);
  return chosen.has((r.entry_id ?? "") as string);
}

export function buildListSample(snapshots: readonly NormalisedSnapshot[], config: SampleConfig): ListSample {
  const chosen = new Set<string>();
  const byRule: Record<string, number> = {};
  for (const snapshot of snapshots) {
    pickByRules(snapshot, config, chosen, byRule);
    pickOwnershipLinks(snapshot, config, chosen, byRule);
  }

  const tables = emptyTables();
  for (const name of TABLE_NAMES) {
    for (const snapshot of snapshots) {
      (tables[name] as object[]).push(...(snapshot.tables[name] as object[]).filter((row) => keeps(name, row, chosen)));
    }
    (tables[name] as object[]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  return {
    tables,
    manifest: {
      label: config.label,
      seed: config.seed,
      snapshots: snapshots.map((s) => ({
        snapshot_id: s.meta.snapshot_id,
        list_id: s.meta.list_id,
        issued_on: s.meta.issued_on,
        source_url: s.meta.source_url,
      })),
      counts: Object.fromEntries(TABLE_NAMES.map((n) => [n, tables[n].length])),
      selected_by_rule: byRule,
    },
  };
}

/** Write the sample as one JSON array per table plus manifest.json. */
export function writeListSample(config: SampleConfig, sample: ListSample, outDir?: string): string {
  const dir = outDir ?? resolveProjectPath(config.outputDir);
  mkdirSync(dir, { recursive: true });
  for (const name of TABLE_NAMES) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(sample.tables[name])}\n`);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(sample.manifest, null, 2)}\n`);
  return dir;
}

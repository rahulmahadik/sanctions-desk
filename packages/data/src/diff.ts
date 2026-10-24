import { z } from "zod";
import { type ListEntryRow, ListIdSchema, type NormalisedSnapshot, PartyKindSchema, type TableRows } from "./model.js";

/**
 * Compare two snapshots of a list. The result says which entries were added, which were removed
 * (delisted) and which changed, and what changed in them. List-change replay uses it to find the
 * customers and payments whose earlier clearance may no longer hold.
 */

export const SCALAR_FIELDS = ["primary_name", "party_kind", "listed_on", "sanctions_list", "remarks"] as const;
export const SET_FIELDS = ["aliases", "identifiers", "dobs", "countries", "programs", "relationships"] as const;

/** Changes to these fields can alter a screening result. Remarks and listing dates cannot. */
export const MATERIAL_FIELDS: ReadonlySet<string> = new Set([
  "primary_name",
  "party_kind",
  "aliases",
  "identifiers",
  "dobs",
  "countries",
  "programs",
  "relationships",
]);

const ScalarChangeSchema = z.strictObject({
  field: z.enum(SCALAR_FIELDS),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
const SetChangeSchema = z.strictObject({
  field: z.enum(SET_FIELDS),
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export const FieldChangeSchema = z.union([ScalarChangeSchema, SetChangeSchema]);
export type FieldChange = z.infer<typeof FieldChangeSchema>;

export const EntryRefSchema = z.strictObject({
  entry_id: z.string().min(1),
  list_id: ListIdSchema,
  party_kind: PartyKindSchema,
  primary_name: z.string().min(1),
});
export type EntryRef = z.infer<typeof EntryRefSchema>;

export const SnapshotDeltaSchema = z.strictObject({
  from_snapshot_id: z.string(),
  to_snapshot_id: z.string(),
  /** Set when the later snapshot was built for demonstration, never for a real published list. */
  synthetic: z.strictObject({ label: z.string() }).optional(),
  summary: z.strictObject({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  added: z.array(EntryRefSchema),
  removed: z.array(EntryRefSchema),
  changed: z.array(EntryRefSchema.extend({ changes: z.array(FieldChangeSchema).min(1) })),
});
export type SnapshotDelta = z.infer<typeof SnapshotDeltaSchema>;

const ref = (e: ListEntryRow): EntryRef => ({
  entry_id: e.entry_id,
  list_id: e.list_id,
  party_kind: e.party_kind,
  primary_name: e.primary_name,
});

/** Human-readable descriptions of the set-valued facts about an entry, used to show what changed. */
function describeSets(tables: TableRows): Record<(typeof SET_FIELDS)[number], Map<string, string[]>> {
  const by = <T extends { entry_id: string }>(rows: readonly T[], text: (row: T) => string) => {
    const out = new Map<string, string[]>();
    for (const row of rows) {
      const list = out.get(row.entry_id) ?? [];
      list.push(text(row));
      out.set(row.entry_id, list);
    }
    return out;
  };
  const relationships = new Map<string, string[]>();
  for (const r of tables.list_relationship) {
    const list = relationships.get(r.from_entry_id) ?? [];
    list.push(`${r.relation_type}${r.is_former ? " (former)" : ""} -> ${r.to_entry_id}`);
    relationships.set(r.from_entry_id, list);
  }
  return {
    aliases: by(tables.list_alias, (a) => `${a.alias_type}: ${a.alias_name}`),
    identifiers: by(
      tables.list_identifier,
      (i) => `${i.id_type}: ${i.id_number}${i.issuing_country ? ` (${i.issuing_country})` : ""}`,
    ),
    dobs: by(
      tables.list_dob,
      (d) => `${d.dob_value ?? `${d.range_from} to ${d.range_to}`}${d.is_approximate ? " (approximate)" : ""}`,
    ),
    countries: by(
      tables.list_country,
      (c) => `${c.role}: ${c.country_iso2 ?? c.country_name ?? "unknown"}${c.place ? ` - ${c.place}` : ""}`,
    ),
    programs: by(tables.list_program, (p) => p.program),
    relationships,
  };
}

function setDiff(before: readonly string[] = [], after: readonly string[] = []) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((x) => !b.has(x)).sort(),
    removed: [...b].filter((x) => !a.has(x)).sort(),
  };
}

type DescribedSets = ReturnType<typeof describeSets>;

/** What differs between two versions of the same entry. Empty when nothing a reader would care about changed. */
function entryChanges(
  before: ListEntryRow,
  after: ListEntryRow,
  fromSets: DescribedSets,
  toSets: DescribedSets,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of SCALAR_FIELDS) {
    if (before[field] !== after[field]) changes.push({ field, before: before[field], after: after[field] });
  }
  for (const field of SET_FIELDS) {
    const { added, removed } = setDiff(fromSets[field].get(after.entry_id), toSets[field].get(after.entry_id));
    if (added.length > 0 || removed.length > 0) changes.push({ field, added, removed });
  }
  return changes;
}

export function diffSnapshots(from: NormalisedSnapshot, to: NormalisedSnapshot): SnapshotDelta {
  const fromEntries = new Map(from.tables.list_entry.map((e) => [e.entry_id, e]));
  const toEntries = new Map(to.tables.list_entry.map((e) => [e.entry_id, e]));
  const fromSets = describeSets(from.tables);
  const toSets = describeSets(to.tables);

  const added: EntryRef[] = [];
  const changed: SnapshotDelta["changed"] = [];
  let unchanged = 0;

  for (const [id, entry] of toEntries) {
    const before = fromEntries.get(id);
    if (!before) {
      added.push(ref(entry));
      continue;
    }
    const changes = before.content_hash === entry.content_hash ? [] : entryChanges(before, entry, fromSets, toSets);
    if (changes.length > 0) changed.push({ ...ref(entry), changes });
    else unchanged += 1;
  }
  const removed = [...fromEntries.values()].filter((e) => !toEntries.has(e.entry_id)).map(ref);

  const byId = (a: EntryRef, b: EntryRef) => a.entry_id.localeCompare(b.entry_id);
  added.sort(byId);
  removed.sort(byId);
  changed.sort(byId);

  return SnapshotDeltaSchema.parse({
    from_snapshot_id: from.meta.snapshot_id,
    to_snapshot_id: to.meta.snapshot_id,
    ...(to.meta.synthetic ? { synthetic: { label: to.meta.synthetic.label } } : {}),
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
    added,
    removed,
    changed,
  });
}

/** Entries whose change could alter a screening result: new, delisted, or materially changed. */
export function affectedEntryIds(delta: SnapshotDelta): string[] {
  const material = delta.changed
    .filter((c) => c.changes.some((ch) => MATERIAL_FIELDS.has(ch.field)))
    .map((c) => c.entry_id);
  return [
    ...new Set([...delta.added.map((e) => e.entry_id), ...delta.removed.map((e) => e.entry_id), ...material]),
  ].sort();
}

import { AppError } from "@sanctions-desk/shared";
import { z } from "zod";
import {
  AliasTypeSchema,
  IdTypeSchema,
  type NormalisedSnapshot,
  sealEntries,
  shortHash,
  type TableRows,
} from "./model.js";
import { countTables } from "./snapshot.js";
import { describeWindow, detectScript, normaliseName, windowOfIso } from "./text.js";

/**
 * Build a clearly labelled synthetic later snapshot from a real one, for the list-change demo.
 *
 * A real list changes slowly, so the demo applies a few explicit edits to real entries (a new alias,
 * a corrected date of birth, a delisting). The result is marked `synthetic` in its metadata and in its
 * id; it is never presented as a published list.
 */

export const DeltaOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add_alias"),
    entry_id: z.string(),
    alias_name: z.string().min(1),
    alias_type: AliasTypeSchema.default("aka"),
  }),
  z.strictObject({ op: z.literal("replace_dobs"), entry_id: z.string(), dob_value: z.string() }),
  z.strictObject({
    op: z.literal("add_identifier"),
    entry_id: z.string(),
    id_type: IdTypeSchema,
    id_number: z.string().min(1),
    issuing_country: z.string().length(2).nullable().default(null),
  }),
  z.strictObject({ op: z.literal("add_program"), entry_id: z.string(), program: z.string().min(1) }),
  z.strictObject({ op: z.literal("rename"), entry_id: z.string(), primary_name: z.string().min(1) }),
  z.strictObject({ op: z.literal("remove_entry"), entry_id: z.string() }),
]);
export type DeltaOp = z.input<typeof DeltaOpSchema>;

function requireEntry(tables: TableRows, id: string) {
  const entry = tables.list_entry.find((e) => e.entry_id === id);
  if (!entry) throw new AppError("validation", `delta refers to an unknown entry ${id}`);
  return entry;
}

export function applyDelta(base: NormalisedSnapshot, ops: readonly DeltaOp[], label: string): NormalisedSnapshot {
  if (label.trim() === "") throw new AppError("validation", "a synthetic delta needs a label");
  const parsed = ops.map((op) => DeltaOpSchema.parse(op));
  const tables = structuredClone(base.tables);

  for (const op of parsed) {
    const entry = requireEntry(tables, op.entry_id);
    switch (op.op) {
      case "add_alias": {
        const script = detectScript(op.alias_name);
        tables.list_alias.push({
          alias_id: `${entry.entry_id}-a-${shortHash(op.alias_type, op.alias_name)}`,
          entry_id: entry.entry_id,
          alias_name: op.alias_name,
          alias_type: op.alias_type,
          script,
          name_normalised: normaliseName(op.alias_name),
          is_primary: false,
          is_strong: op.alias_type !== "low_quality",
        });
        break;
      }
      case "replace_dobs": {
        const window = windowOfIso(op.dob_value);
        if (!window) throw new AppError("validation", `"${op.dob_value}" is not a valid partial date`);
        const d = describeWindow(window.from, window.to);
        tables.list_dob = tables.list_dob.filter((r) => r.entry_id !== entry.entry_id);
        tables.list_dob.push({
          dob_id: `${entry.entry_id}-d-${shortHash(d.value ?? "", "synthetic")}`,
          entry_id: entry.entry_id,
          dob_value: d.value,
          dob_precision: d.precision,
          range_from: d.rangeFrom,
          range_to: d.rangeTo,
          is_approximate: false,
        });
        break;
      }
      case "add_identifier":
        tables.list_identifier.push({
          identifier_id: `${entry.entry_id}-i-${shortHash(op.id_type, op.id_number, op.issuing_country ?? "")}`,
          entry_id: entry.entry_id,
          id_type: op.id_type,
          id_number: op.id_number,
          issuing_country: op.issuing_country,
          note: "added by synthetic delta",
        });
        break;
      case "add_program":
        tables.list_program.push({
          program_id: `${entry.entry_id}-p-${shortHash(op.program)}`,
          entry_id: entry.entry_id,
          program: op.program,
        });
        break;
      case "rename":
        entry.primary_name = op.primary_name;
        entry.name_normalised = normaliseName(op.primary_name);
        entry.primary_name_script = detectScript(op.primary_name);
        break;
      case "remove_entry": {
        const id = entry.entry_id;
        tables.list_entry = tables.list_entry.filter((e) => e.entry_id !== id);
        tables.list_alias = tables.list_alias.filter((r) => r.entry_id !== id);
        tables.list_identifier = tables.list_identifier.filter((r) => r.entry_id !== id);
        tables.list_dob = tables.list_dob.filter((r) => r.entry_id !== id);
        tables.list_country = tables.list_country.filter((r) => r.entry_id !== id);
        tables.list_program = tables.list_program.filter((r) => r.entry_id !== id);
        tables.list_relationship = tables.list_relationship.filter(
          (r) => r.from_entry_id !== id && r.to_entry_id !== id,
        );
        break;
      }
    }
  }

  const snapshotId = `${base.meta.snapshot_id}+synthetic-${shortHash(label, JSON.stringify(parsed))}`;
  for (const entry of tables.list_entry) entry.snapshot_id = snapshotId;
  sealEntries(tables);
  return {
    meta: {
      ...base.meta,
      snapshot_id: snapshotId,
      raw_file: "synthetic-delta",
      synthetic: { label, base_snapshot_id: base.meta.snapshot_id },
      counts: countTables(tables),
    },
    tables,
  };
}

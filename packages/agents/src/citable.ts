import type { Policy } from "@sanctions-desk/shared";
import type { UslModel } from "@sanctions-desk/zetaris";

/**
 * What a recommendation may cite: rows of the tables the checking step (the critic) may read, by their key, and only
 * the columns it can check. Free-text columns are left out (the checking step never quotes them), so are the columns it
 * may not read (the identifier number), and the blocks of the evidence worked out by code are not tables at all.
 * The decision step is told exactly this list, and the critic uses the same rules to tell a citation that cannot be
 * cited from one whose value does not hold.
 */

/** Columns that hold free text: notes, payment references, list remarks, and any column described as free text. */
export const FREE_TEXT_COLUMNS: readonly string[] = ["notes", "payment_reference", "remarks"];

export function isFreeTextColumn(column: string, description?: string | null): boolean {
  return FREE_TEXT_COLUMNS.includes(column.toLowerCase()) || /free[- ]text/i.test(description ?? "");
}

/** Blocks of the evidence worked out by code. They are not tables, so a citation of one cannot be checked. */
export const COMPUTED_BLOCKS: readonly string[] = [
  "comparison",
  "definitions",
  "data_quality",
  "screener_facts",
  "first_finding",
  "ownership",
  "earlier_decisions",
  "date_of_birth_from_verified_note",
  "identifier_overlap_types",
  "list_identifier_types",
  "data_safety",
  "close_blockers",
];

export interface CitableTable {
  key: string;
  columns: string[];
}

/** The tables and columns a fact may cite, each table with the key a row is named by. */
export function citableSources(policy: Policy, model: UslModel): Record<string, CitableTable> {
  const access = policy.agentAccess.critic;
  const tables = new Set(access.tables.map((t) => t.toLowerCase()));
  const denied = new Set(access.denyColumns.map((c) => c.toLowerCase()));
  const out: Record<string, CitableTable> = {};
  for (const table of model.tables) {
    if (!table.activated || !tables.has(table.name.toLowerCase())) continue;
    const key = table.columns.find((c) => c.primaryKey)?.name;
    if (!key || denied.has(key.toLowerCase())) continue;
    const columns = table.columns
      .filter((c) => !denied.has(c.name.toLowerCase()) && !isFreeTextColumn(c.name, c.description))
      .map((c) => c.name);
    out[table.name] = { key, columns };
  }
  return out;
}

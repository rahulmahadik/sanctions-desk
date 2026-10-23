import { AppError, hashRow } from "@sanctions-desk/shared";
import type { QueryResult, ZetarisClient, ZetarisRole } from "./client.js";
import type { UslColumn, UslModel, UslTable } from "./metadata.js";

/**
 * Read-only tools generated from the semantic layer's own description: one `find_<table>` tool per table,
 * with the columns, keys and descriptions Zetaris reports. Nothing here names a table or column.
 */

export type Row = Record<string, string | null>;

export interface ToolCitationKey {
  column: string;
  value: string;
}

export interface ToolResult {
  tool: string;
  table: string;
  query: QueryResult;
  rows: Row[];
  /** SHA-256 of each row exactly as Zetaris returned it, before any masking done here. */
  rowHashes: string[];
  maskedColumns: string[];
  /** The key column values of each row, for citations. */
  rowKeys: string[];
}

export interface EvidenceTool {
  name: string;
  table: UslTable;
  /** Plain-text description for the tool list shown to a model. */
  description: string;
  columns: string[];
  find(filters: Record<string, string>, options?: { limit?: number; signal?: AbortSignal }): Promise<ToolResult>;
}

export interface ToolOptions {
  role: ZetarisRole;
  /** Row limit used when a call does not set one. */
  defaultLimit: number;
  /** When true, columns whose description is marked "(sensitive)" are masked before the caller sees them. */
  maskSensitive: boolean;
}

export const SENSITIVE_MARK = "(sensitive)";

export function isSensitive(column: UslColumn): boolean {
  return (column.description ?? "").toLowerCase().includes(SENSITIVE_MARK);
}

/** Keep the last two characters of a value and hide the rest. */
export function maskValue(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.min(value.length - 2, 8))}${value.slice(-2)}`;
}

/**
 * Quote a value as an SQL string. A doubled quote is the only escape used. A backslash is refused because a
 * Spark-style engine reads it as an escape, which could move the end of the string; the SQL guard refuses it too.
 */
export function quoteLiteral(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f;\\]/.test(value) || value.includes("${")) {
    throw new AppError("validation", "a filter value contains a character that is not allowed");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export const quoteIdentifier = (name: string): string => `\`${name}\``;

function describeTool(table: UslTable): string {
  const keys = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const links = table.columns
    .filter((c) => c.references)
    .map((c) => `${c.name} -> ${c.references?.table.split(".").pop()}`);
  const parts = [table.description ?? table.name, `columns: ${table.columns.map((c) => c.name).join(", ")}`];
  if (keys.length > 0) parts.push(`key: ${keys.join(", ")}`);
  if (links.length > 0) parts.push(`links: ${links.join(", ")}`);
  return parts.join(". ");
}

export function buildEvidenceTools(
  model: UslModel,
  client: ZetarisClient,
  options: ToolOptions,
): Map<string, EvidenceTool> {
  const tools = new Map<string, EvidenceTool>();
  for (const table of model.tables.filter((t) => t.activated)) {
    const columns = table.columns.map((c) => c.name);
    const sensitive = options.maskSensitive ? table.columns.filter(isSensitive).map((c) => c.name) : [];
    const keyColumns = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const name = `find_${table.name}`;
    tools.set(name, {
      name,
      table,
      description: describeTool(table),
      columns,
      async find(filters, callOptions = {}) {
        const entries = Object.entries(filters);
        if (entries.length === 0) throw new AppError("validation", `${name} needs at least one filter`);
        for (const [column] of entries) {
          if (!columns.includes(column)) throw new AppError("validation", `${table.name} has no column "${column}"`);
        }
        const limit = Math.min(callOptions.limit ?? options.defaultLimit, options.defaultLimit);
        const where = entries.map(([c, v]) => `${quoteIdentifier(c)} = ${quoteLiteral(v)}`).join(" AND ");
        const order = keyColumns.length > 0 ? ` ORDER BY ${keyColumns.map(quoteIdentifier).join(", ")}` : "";
        const sql = `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${table.qualifiedName} WHERE ${where}${order} LIMIT ${limit}`;
        const query = await client.query(options.role, sql, callOptions.signal);
        const rowHashes = query.objects.map((r) => hashRow(r));
        const rows = query.objects.map((r) => {
          const copy: Row = { ...r };
          for (const column of sensitive) copy[column] = maskValue(copy[column] ?? null);
          return copy;
        });
        const rowKeys = query.objects.map((r) => keyColumns.map((k) => r[k] ?? "").join("|"));
        return { tool: name, table: table.qualifiedName, query, rows, rowHashes, maskedColumns: sensitive, rowKeys };
      },
    });
  }
  return tools;
}

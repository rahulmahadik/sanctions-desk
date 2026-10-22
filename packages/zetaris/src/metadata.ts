import { AppError, hashValue } from "@sanctions-desk/shared";
import { z } from "zod";
import type { QueryResult, ZetarisClient, ZetarisRole } from "./client.js";

/**
 * Metadata of the semantic layer, read at run time through Zetaris itself. The evidence tools are built
 * from this, so a new table or column appears without a code change.
 */

export interface UslColumn {
  name: string;
  type: string;
  description: string | null;
  primaryKey: boolean;
  notNull: boolean;
  references: { table: string; column: string } | null;
}
export interface UslDqRule {
  name: string;
  expression: string;
}
export interface UslTable {
  name: string;
  qualifiedName: string;
  description: string | null;
  activated: boolean;
  columns: UslColumn[];
  dqRules: UslDqRule[];
}
export interface UslModel {
  namespace: string;
  name: string;
  description: string | null;
  /** Hash of the model as Zetaris describes it. Changes when a table, column, key or rule changes. */
  version: string;
  tables: UslTable[];
}

const ColumnSchema = z
  .object({
    name: z.string().min(1),
    dataType: z.string(),
    description: z.string().nullish(),
    primaryKey: z.unknown().optional(),
    notNull: z.unknown().optional(),
    foreignKey: z
      .object({ refTable: z.array(z.string()).min(1), refColumns: z.array(z.string()).min(1) })
      .partial()
      .optional(),
  })
  .loose();

const TableSchema = z
  .object({
    name: z.string().min(1),
    namespace: z.array(z.string()).min(1),
    description: z.string().nullish(),
    columnSpecs: z.array(ColumnSchema),
    dqAnnotations: z.array(z.object({ name: z.string(), expression: z.string() }).loose()).default([]),
    activateQuery: z.string().nullish(),
  })
  .loose();

const ModelSchema = z
  .object({
    name: z.string().min(1),
    namespace: z.array(z.string()).min(1),
    description: z.string().nullish(),
    tables: z.array(TableSchema),
  })
  .loose();

/** "\"varchar(64)\"" -> "varchar(64)" */
const typeText = (raw: string): string => raw.replace(/^"+|"+$/g, "");

/** Parse the JSON that `LOAD USL` returns into a model. The shape is validated; unknown fields are ignored. */
export function parseUslModel(json: unknown): UslModel {
  const parsed = ModelSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError("bad_response", "the semantic layer description has an unexpected shape", {
      details: { issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) },
    });
  }
  const model = parsed.data;
  return {
    namespace: ["lightning", ...model.namespace].join("."),
    name: model.name,
    description: model.description ?? null,
    version: hashValue(json).slice(0, 12),
    tables: model.tables.map((t) => ({
      name: t.name,
      qualifiedName: `${t.namespace.join(".")}.${t.name}`,
      description: t.description ?? null,
      activated: typeof t.activateQuery === "string" && t.activateQuery.length > 0,
      dqRules: t.dqAnnotations.map((d) => ({ name: d.name, expression: d.expression })),
      columns: t.columnSpecs.map((c) => ({
        name: c.name,
        type: typeText(c.dataType),
        description: c.description ?? null,
        primaryKey: c.primaryKey !== undefined,
        notNull: c.notNull !== undefined,
        references:
          c.foreignKey?.refTable?.[0] && c.foreignKey.refColumns?.[0]
            ? { table: c.foreignKey.refTable[0], column: c.foreignKey.refColumns[0] }
            : null,
      })),
    })),
  };
}

function jsonFrom(result: QueryResult): unknown {
  const cell = result.rows[0]?.[0];
  if (cell === null || cell === undefined) throw new AppError("bad_response", "LOAD USL returned no model");
  try {
    return JSON.parse(cell);
  } catch {
    throw new AppError("bad_response", "LOAD USL did not return JSON");
  }
}

/**
 * Read the model through Zetaris and tell the client which tables the guard may allow.
 * Only activated tables are allowed.
 */
export async function loadUslModel(
  client: ZetarisClient,
  role: ZetarisRole,
  namespace: string,
  usl: string,
): Promise<{ model: UslModel; query: QueryResult }> {
  const query = await client.query(role, `LOAD USL ${usl} NAMESPACE ${namespace}`);
  const model = parseUslModel(jsonFrom(query));
  client.setAllowedTables(model.tables.filter((t) => t.activated).map((t) => t.qualifiedName));
  return { model, query };
}

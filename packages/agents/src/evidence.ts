import { type BusinessDefinition, checkDefinitions, type DefinitionCheck } from "@sanctions-desk/data";
import { AppError, type QueryEvidenceInput } from "@sanctions-desk/shared";
import {
  buildEvidenceTools,
  type EvidenceTool,
  loadUslModel,
  type ToolResult,
  type UslModel,
} from "@sanctions-desk/zetaris";
import type { AgentDeps, Row } from "./types.js";

/**
 * The Evidence agent reads what it needs from the semantic layer. It learns the tables, columns and keys
 * from Zetaris itself at the start of the run and builds its tools from that description.
 */

export interface DqFinding {
  table: string;
  rule: string;
  failed: boolean;
}

export interface EvidenceBundle {
  model: UslModel;
  alert: Row;
  customer: Row;
  customerIdentifiers: Row[];
  entry: Row;
  aliases: Row[];
  dobs: Row[];
  countries: Row[];
  listIdentifiers: Row[];
  /** Identifier types for which a customer number equals a listed number (worked out inside Zetaris). */
  identifierOverlap: string[];
  dq: DqFinding[];
  /** Approved wording of the terms applied, as read from the semantic layer. */
  definitions: Array<Pick<BusinessDefinition, "definition_id" | "version" | "statement" | "status">>;
  definitionCheck: DefinitionCheck;
  queries: QueryEvidenceInput[];
  citations: Array<{ source: "zetaris"; query_id: string; table: string; row_keys: string[] }>;
  /** Free text from the data layer that a model will read; scanned for injected instructions. */
  freeText: string[];
}

const REQUIRED_TABLES = [
  "alert",
  "customer",
  "customer_identifier",
  "list_entry",
  "list_alias",
  "list_dob",
  "list_country",
  "list_identifier",
  "business_definition",
] as const;

function first(result: ToolResult, what: string): Row {
  const row = result.rows[0];
  if (!row) throw new AppError("not_found", `no ${what} found`, { details: { table: result.table } });
  return row;
}

/** SQL that counts customer identifiers equal to listed identifiers; the numbers never leave Zetaris. */
function overlapSql(model: UslModel, customerId: string, entryId: string): string {
  const base = `${model.namespace}.${model.name}`;
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const norm = (c: string) => `regexp_replace(upper(${c}), '[^A-Z0-9]', '')`;
  return (
    `SELECT ci.id_type AS id_type, COUNT(*) AS n FROM ${base}.customer_identifier ci ` +
    `JOIN ${base}.list_identifier li ON ${norm("ci.id_number")} = ${norm("li.id_number")} ` +
    `WHERE ci.customer_id = ${q(customerId)} AND li.entry_id = ${q(entryId)} GROUP BY ci.id_type`
  );
}

export async function gatherEvidence(deps: AgentDeps, alertId: string): Promise<EvidenceBundle> {
  const { zetaris, policy, trace } = deps;
  const role = policy.masking.evidence;
  const { model } = await loadUslModel(zetaris, "evidence", deps.config.zetaris.namespace, deps.config.zetaris.usl);
  trace.log({
    agent: "evidence",
    action: "read_semantic_layer",
    status: "ok",
    output_summary: `${model.name} v${model.version}: ${model.tables.length} tables`,
    detail: { tables: model.tables.map((t) => t.name) },
  });
  const missing = REQUIRED_TABLES.filter((t) => !model.tables.some((m) => m.name === t && m.activated));
  if (missing.length > 0) {
    throw new AppError("config_missing", `the semantic layer is missing tables: ${missing.join(", ")}`, {
      recoverable: true,
    });
  }

  const tools = buildEvidenceTools(model, zetaris, {
    role: "evidence",
    defaultLimit: deps.config.zetaris.maxRows,
    maskSensitive: true,
  });
  const queries: QueryEvidenceInput[] = [];
  const citations: EvidenceBundle["citations"] = [];

  const read = async (tool: string, filters: Record<string, string>): Promise<ToolResult> => {
    const t: EvidenceTool | undefined = tools.get(tool);
    if (!t) throw new AppError("config_missing", `tool ${tool} is not available`);
    const result = await t.find(filters);
    trace.log({
      agent: "evidence",
      action: tool,
      status: "ok",
      input_summary: Object.entries(filters)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
      output_summary: `${result.rows.length} rows`,
      zetaris_query_id: result.query.query_id,
      latency_ms: result.query.latency_ms,
      detail: { table: result.table, role: result.query.role, token_source: result.query.token_source },
    });
    queries.push({
      query_id: result.query.query_id,
      agent: "evidence",
      role,
      table: result.table,
      sql: result.query.sql,
      sql_hash: result.query.sql_hash,
      row_count: result.rows.length,
      row_hashes: result.rowHashes,
      masked_columns: result.maskedColumns,
    });
    citations.push({
      source: "zetaris",
      query_id: result.query.query_id,
      table: result.table,
      row_keys: result.rowKeys,
    });
    return result;
  };

  const alert = first(await read("find_alert", { alert_id: alertId }), `alert ${alertId}`);
  const customerId = alert.customer_id ?? "";
  const entryId = alert.entry_id ?? "";
  const customer = first(await read("find_customer", { customer_id: customerId }), `customer ${customerId}`);
  const customerIdentifiers = (await read("find_customer_identifier", { customer_id: customerId })).rows;
  const entry = first(await read("find_list_entry", { entry_id: entryId }), `list entry ${entryId}`);
  const aliases = (await read("find_list_alias", { entry_id: entryId })).rows;
  const dobs = (await read("find_list_dob", { entry_id: entryId })).rows;
  const countries = (await read("find_list_country", { entry_id: entryId })).rows;
  const listIdentifiers = (await read("find_list_identifier", { entry_id: entryId })).rows;
  const definitionRows = (await read("find_business_definition", { status: "approved" })).rows;
  const definitions = definitionRows.map((r) => ({
    definition_id: r.definition_id ?? "",
    version: r.version ?? "",
    statement: r.statement ?? "",
    status: (r.status ?? "approved") as BusinessDefinition["status"],
  }));
  const definitionCheck = checkDefinitions(definitions);
  trace.log({
    agent: "evidence",
    action: "definitions",
    status: definitionCheck.mismatched.length === 0 ? "ok" : "blocked",
    output_summary: definitionCheck.applied.map((d) => `${d.definition_id}@${d.version}`).join(", "),
    detail: { mismatched: definitionCheck.mismatched },
  });

  const overlap = await zetaris.query("evidence", overlapSql(model, customerId, entryId));
  trace.log({
    agent: "evidence",
    action: "identifier_overlap",
    status: "ok",
    output_summary:
      overlap.rows.length === 0
        ? "no identifier matches"
        : `matches: ${overlap.objects.map((o) => o.id_type).join(", ")}`,
    zetaris_query_id: overlap.query_id,
    latency_ms: overlap.latency_ms,
  });
  queries.push({
    query_id: overlap.query_id,
    agent: "evidence",
    role,
    table: `${model.namespace}.${model.name}.customer_identifier`,
    sql: overlap.sql,
    sql_hash: overlap.sql_hash,
    row_count: overlap.rows.length,
    row_hashes: [],
    masked_columns: [],
  });

  const dq = await checkDataQuality(deps, model, "customer", customerId, queries, role);

  const freeText = [customer.full_name, entry.primary_name, entry.remarks, ...aliases.map((a) => a.alias_name)].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  return {
    model,
    alert,
    customer,
    customerIdentifiers,
    entry,
    aliases,
    dobs,
    countries,
    listIdentifiers,
    identifierOverlap: overlap.objects.map((o) => o.id_type ?? "").filter((t) => t !== ""),
    dq,
    definitions,
    definitionCheck,
    queries,
    citations,
    freeText,
  };
}

/** Does this record fail any data-quality rule written on its table? */
async function checkDataQuality(
  deps: AgentDeps,
  model: UslModel,
  tableName: string,
  keyValue: string,
  queries: QueryEvidenceInput[],
  role: string,
): Promise<DqFinding[]> {
  const table = model.tables.find((t) => t.name === tableName);
  if (!table) return [];
  const keyColumn = table.columns.find((c) => c.primaryKey)?.name;
  const findings: DqFinding[] = [];
  for (const rule of table.dqRules) {
    const result = await deps.zetaris.query(
      "evidence",
      `SHOW DQ INVALID RECORD ${rule.name} TABLE ${table.qualifiedName}`,
    );
    const failed = result.objects.some((o) =>
      keyColumn ? o[keyColumn] === keyValue : Object.values(o).includes(keyValue),
    );
    findings.push({ table: table.name, rule: rule.name, failed });
    deps.trace.log({
      agent: "evidence",
      action: "data_quality",
      status: failed ? "blocked" : "ok",
      input_summary: `${table.name}.${rule.name} for ${keyValue}`,
      output_summary: failed ? "record fails this rule" : "record passes this rule",
      zetaris_query_id: result.query_id,
      latency_ms: result.latency_ms,
    });
    queries.push({
      query_id: result.query_id,
      agent: "evidence",
      role,
      table: table.qualifiedName,
      sql: result.sql,
      sql_hash: result.sql_hash,
      row_count: result.rows.length,
      row_hashes: [],
      masked_columns: [],
    });
  }
  return findings;
}

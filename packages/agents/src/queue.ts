import { AppError } from "@sanctions-desk/shared";
import { loadUslModel } from "@sanctions-desk/zetaris";
import type { AgentDeps } from "./types.js";

export interface QueueItem {
  alert_id: string;
  alert_type: string;
  alert_source: string;
  customer_id: string;
  entry_id: string;
  matched_name: string;
  match_score: number;
  status: string;
}

const COLUMNS = [
  "alert_id",
  "alert_type",
  "alert_source",
  "customer_id",
  "entry_id",
  "matched_name",
  "match_score",
  "status",
] as const;

/** The alerts waiting for review, read through the semantic layer like every other fact. */
export async function readAlertQueue(deps: Pick<AgentDeps, "zetaris" | "config">): Promise<QueueItem[]> {
  const { zetaris, config } = deps;
  const { model } = await loadUslModel(zetaris, "evidence", config.zetaris.namespace, config.zetaris.usl);
  const table = model.tables.find((t) => t.name === "alert" && t.activated);
  if (!table)
    throw new AppError("config_missing", "the semantic layer has no active alert table", { recoverable: true });
  const sql = `SELECT ${COLUMNS.map((c) => `\`${c}\``).join(", ")} FROM ${table.qualifiedName} ORDER BY \`alert_id\` LIMIT ${config.zetaris.maxRows}`;
  const result = await zetaris
    .scoped({ agent: "evidence", tables: ["alert"], denyColumns: ["id_number"] })
    .query("evidence", sql);
  return result.objects.map((row) => ({
    alert_id: String(row.alert_id),
    alert_type: String(row.alert_type),
    alert_source: String(row.alert_source),
    customer_id: String(row.customer_id),
    entry_id: String(row.entry_id),
    matched_name: String(row.matched_name),
    match_score: Number(row.match_score),
    status: String(row.status),
  }));
}

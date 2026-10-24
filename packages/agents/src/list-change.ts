import {
  type DispositionRef,
  type EntryLookup,
  type RescreenCandidate,
  type RescreenResult,
  rescreen,
} from "@sanctions-desk/engines";
import { loadUslModel, quoteLiteral } from "@sanctions-desk/zetaris";
import { type AgentDeps, clientFor, type Row } from "./types.js";

/**
 * List-change replay. After a sanctions list is updated, find the earlier decisions whose listed entry changed
 * (they must be looked at again) or was removed (an escalation that rested on it is a candidate for release by a
 * person), and say what that means for the portfolio: how many customers, and how many of their payments are
 * waiting. Everything is read through Zetaris; the comparison is the re-screen engine's.
 */

export interface ListChangeOptions {
  batchSize?: number;
  maxBatches?: number;
  cursor?: number;
}

export interface ListChangeCase extends RescreenCandidate {
  entry_name: string | null;
  /** The list snapshot the earlier decision was made against, when the disposition recorded one. */
  earlier_snapshot_id: string | null;
  /** Alerts on this customer and listed party that are still open and should be reviewed again. */
  open_alert_ids: string[];
}

export interface ListChangeReport {
  total: number;
  examined: number;
  batches: number;
  complete: boolean;
  next_cursor: number | null;
  reopen: ListChangeCase[];
  release: ListChangeCase[];
  unchanged: number;
  moot: number;
  impact: {
    customers: number;
    pending_payments: number;
    pending_amount_by_currency: Record<string, string>;
    summary: string;
  };
}

const list = (ids: readonly string[]): string => ids.map(quoteLiteral).join(", ");

async function read(deps: AgentDeps, sql: string): Promise<Row[]> {
  const result = await clientFor(deps, "evidence").query("evidence", sql);
  deps.trace.log({
    agent: "memory",
    action: "list_change_read",
    status: "ok",
    output_summary: `${result.rows.length} rows`,
    zetaris_query_id: result.query_id,
    latency_ms: result.latency_ms,
  });
  return result.objects;
}

function addAmounts(rows: readonly Row[]): Record<string, string> {
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.currency ?? "?"] = (totals[r.currency ?? "?"] ?? 0) + Number(r.amount ?? 0);
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)]));
}

export async function replayListChange(deps: AgentDeps, options: ListChangeOptions = {}): Promise<ListChangeReport> {
  const { model } = await loadUslModel(
    deps.zetaris,
    "evidence",
    deps.config.zetaris.namespace,
    deps.config.zetaris.usl,
  );
  const q = (name: string) => model.tables.find((t) => t.name === name)?.qualifiedName ?? name;

  const dispositionRows = await read(
    deps,
    `SELECT \`disposition_id\`, \`customer_id\`, \`entry_id\`, \`decision\`, \`entry_content_hash\`, \`list_snapshot_id\` FROM ${q("disposition")} ORDER BY \`disposition_id\``,
  );
  const dispositions: DispositionRef[] = dispositionRows.map((r) => ({
    disposition_id: r.disposition_id ?? "",
    customer_id: r.customer_id ?? "",
    entry_id: r.entry_id ?? "",
    decision: (r.decision ?? "CLOSE_FALSE_POSITIVE") as DispositionRef["decision"],
    entry_content_hash: r.entry_content_hash ?? "",
    ...(r.list_snapshot_id ? { list_snapshot_id: r.list_snapshot_id } : {}),
  }));

  const names = new Map<string, string>();
  const lookup: EntryLookup = async (ids) => {
    const rows = await read(
      deps,
      `SELECT \`entry_id\`, \`primary_name\`, \`content_hash\`, \`snapshot_id\` FROM ${q("list_entry")} WHERE \`entry_id\` IN (${list(ids)})`,
    );
    for (const r of rows) names.set(r.entry_id ?? "", r.primary_name ?? "");
    return new Map(
      rows.map((r) => [
        r.entry_id ?? "",
        { content_hash: r.content_hash ?? "", ...(r.snapshot_id ? { list_snapshot_id: r.snapshot_id } : {}) },
      ]),
    );
  };

  const result: RescreenResult = await rescreen(dispositions, lookup, {
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
    startCursor: options.cursor,
  });

  const customers = [...new Set(result.reopen.map((c) => c.customer_id))];
  const [alertRows, paymentRows] =
    customers.length === 0
      ? [[], []]
      : await Promise.all([
          read(
            deps,
            `SELECT \`alert_id\`, \`customer_id\`, \`entry_id\` FROM ${q("alert")} WHERE \`status\` = 'open' AND \`customer_id\` IN (${list(customers)})`,
          ),
          read(
            deps,
            `SELECT \`payment_id\`, \`customer_id\`, \`amount\`, \`currency\` FROM ${q("payment")} WHERE \`status\` = 'pending' AND \`customer_id\` IN (${list(customers)})`,
          ),
        ]);

  const earlierSnapshot = new Map(dispositions.map((d) => [d.disposition_id, d.list_snapshot_id ?? null]));
  const withContext = (c: RescreenCandidate): ListChangeCase => ({
    ...c,
    entry_name: names.get(c.entry_id) ?? null,
    earlier_snapshot_id: earlierSnapshot.get(c.disposition_id) ?? null,
    open_alert_ids: alertRows
      .filter((a) => a.customer_id === c.customer_id && a.entry_id === c.entry_id)
      .map((a) => a.alert_id ?? ""),
  });
  const impact = {
    customers: customers.length,
    pending_payments: paymentRows.length,
    pending_amount_by_currency: addAmounts(paymentRows),
    summary: `affects ${customers.length} customer${customers.length === 1 ? "" : "s"} and ${paymentRows.length} pending payment${paymentRows.length === 1 ? "" : "s"}`,
  };
  const report: ListChangeReport = {
    total: result.total,
    examined: result.examined,
    batches: result.batches,
    complete: result.complete,
    next_cursor: result.nextCursor,
    reopen: result.reopen.map(withContext),
    release: result.release.map(withContext),
    unchanged: result.unchanged,
    moot: result.moot,
    impact,
  };
  deps.trace.log({
    agent: "memory",
    action: "list_change_replay",
    status: report.reopen.length > 0 || report.release.length > 0 ? "blocked" : "ok",
    output_summary: `${report.reopen.length} to re-open, ${report.release.length} to release, ${report.unchanged} unchanged; ${impact.summary}`,
    detail: { batches: report.batches, complete: report.complete },
  });
  return report;
}

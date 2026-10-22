import type { Config, DecisionRecord } from "@sanctions-desk/shared";
import { verifyDecisionRecord } from "@sanctions-desk/shared";

/**
 * The decision trace: for any recommendation, four plain answers read from its sealed record.
 *   1. Which approved definitions were applied (id and version, with a hash of the wording).
 *   2. What data it rested on (query ids, row keys through the citations, content hashes, list snapshots).
 *   3. Who was allowed to see what (the access role of each query, whether it used its own token, masked columns).
 *   4. What it cost to produce (tokens, models and routes, reasoning on or off, latency, data query time, cache use).
 */

export interface TraceContract {
  case: { alert_ref: string; alert_type: string; record_id: string; run_id: string; decided_at: string };
  record: { hash: string; verified: boolean };
  outcome: { decision: string; confidence: number; human_review_required: true };
  definitions: Array<{ definition_id: string; version: string; statement_hash?: string }>;
  data: {
    usl: { namespace: string; model_version: string };
    list_snapshots: DecisionRecord["list_snapshots"];
    queries: Array<{
      query_id: string;
      agent: string;
      table: string;
      sql_hash: string;
      rows: number;
      row_hashes: number;
      latency_ms?: number;
      cache_hit?: boolean;
    }>;
  };
  access: {
    policy: DecisionRecord["policy"];
    by_role: Array<{ role: string; queries: number; token_source: string; masked_columns: string[] }>;
    note: string;
  };
  cost: {
    currency: string;
    assumption: string;
    models: Array<{
      agent: string;
      model_requested: string;
      model_routed: string;
      provider: string;
      route_kind: string | null;
      reasoning: string;
      tokens_in?: number;
      tokens_out?: number;
      latency_ms?: number;
      receipt_status: string;
      from_cache?: boolean;
      cost: number;
    }>;
    data_queries: { count: number; total_latency_ms: number; rows_returned: number; cache_hits: number; cost: number };
    totals: {
      tokens_in: number;
      tokens_out: number;
      local_calls: number;
      cloud_calls: number;
      model_cost: number;
      total_cost: number;
    };
  };
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

function thinkingText(thinking: DecisionRecord["models"][number]["thinking"]): string {
  if (thinking === undefined || thinking === "off") return "off";
  return thinking === "on" ? "on" : `on (budget ${thinking.budgetTokens} tokens)`;
}

export function buildTraceContract(record: DecisionRecord, costs: Config["costs"]): TraceContract {
  const models = record.models.map((m) => {
    const cloud = m.route_kind === "cloud";
    const tokensIn = m.tokens_in ?? 0;
    const tokensOut = m.tokens_out ?? 0;
    const cost = cloud
      ? (tokensIn * costs.cloudInputPerMillionTokens + tokensOut * costs.cloudOutputPerMillionTokens) / 1_000_000
      : ((tokensIn + tokensOut) * costs.localPerMillionTokens) / 1_000_000;
    return {
      agent: m.agent,
      model_requested: m.model_requested,
      model_routed: m.model_routed,
      provider: m.provider,
      route_kind: m.route_kind,
      reasoning: thinkingText(m.thinking),
      ...(m.tokens_in !== undefined ? { tokens_in: m.tokens_in } : {}),
      ...(m.tokens_out !== undefined ? { tokens_out: m.tokens_out } : {}),
      ...(m.latency_ms !== undefined ? { latency_ms: m.latency_ms } : {}),
      receipt_status: m.receipt?.verification ?? "none",
      ...(m.receipt?.from_cache !== undefined ? { from_cache: m.receipt.from_cache } : {}),
      cost: round(cost),
    };
  });

  const byRole = new Map<string, { queries: number; sources: Set<string>; masked: Set<string> }>();
  for (const q of record.queries) {
    const entry = byRole.get(q.role) ?? { queries: 0, sources: new Set<string>(), masked: new Set<string>() };
    entry.queries += 1;
    entry.sources.add(q.token_source ?? "unknown");
    for (const c of q.masked_columns) entry.masked.add(c);
    byRole.set(q.role, entry);
  }

  const dataCost = record.queries.length * costs.perDataQuery;
  const modelCost = models.reduce((sum, m) => sum + m.cost, 0);
  return {
    case: {
      alert_ref: record.alert_ref,
      alert_type: record.alert_type,
      record_id: record.record_id,
      run_id: record.run_id,
      decided_at: record.decided_at,
    },
    record: { hash: record.record_hash, verified: verifyDecisionRecord(record) },
    outcome: { decision: record.decision, confidence: record.confidence, human_review_required: true },
    definitions: record.definitions,
    data: {
      usl: record.usl,
      list_snapshots: record.list_snapshots,
      queries: record.queries.map((q) => ({
        query_id: q.query_id,
        agent: q.agent,
        table: q.table,
        sql_hash: q.sql_hash,
        rows: q.row_count,
        row_hashes: q.row_hashes.length,
        ...(q.latency_ms !== undefined ? { latency_ms: q.latency_ms } : {}),
        ...(q.cache_hit !== undefined ? { cache_hit: q.cache_hit } : {}),
      })),
    },
    access: {
      policy: record.policy,
      by_role: [...byRole].map(([role, e]) => ({
        role,
        queries: e.queries,
        token_source: [...e.sources].join("+"),
        masked_columns: [...e.masked].sort(),
      })),
      note: "token_source 'role' means the query ran under that role's own API token; 'fallback' means the labelled admin fallback was used because no role token was set.",
    },
    cost: {
      currency: costs.currency,
      assumption: costs.note,
      models,
      data_queries: {
        count: record.queries.length,
        total_latency_ms: record.queries.reduce((s, q) => s + (q.latency_ms ?? 0), 0),
        rows_returned: record.queries.reduce((s, q) => s + q.row_count, 0),
        cache_hits: record.queries.filter((q) => q.cache_hit === true).length,
        cost: round(dataCost),
      },
      totals: {
        tokens_in: models.reduce((s, m) => s + (m.tokens_in ?? 0), 0),
        tokens_out: models.reduce((s, m) => s + (m.tokens_out ?? 0), 0),
        local_calls: models.filter((m) => m.route_kind !== "cloud").length,
        cloud_calls: models.filter((m) => m.route_kind === "cloud").length,
        model_cost: round(modelCost),
        total_cost: round(modelCost + dataCost),
      },
    },
  };
}

import { type DecisionRecord, loadConfig, sealDecisionRecord, sha256Hex } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { buildTraceContract } from "../src/index.js";

const sha = (c: string) => c.repeat(64);
const costs = loadConfig({ env: {} }).costs;

function record(over: Partial<Parameters<typeof sealDecisionRecord>[0]> = {}): DecisionRecord {
  return sealDecisionRecord({
    record_id: "rec-1",
    run_id: "run-1",
    alert_type: "customer",
    alert_ref: "ALR-1",
    decided_at: "2026-10-22T12:00:00.000Z",
    as_of: "2026-10-22T12:00:00.000Z",
    decision: "ESCALATE_L2",
    confidence: 0.9,
    rationale: "r",
    policy: { version: 1, hash: sha("a") },
    definitions: [{ definition_id: "true_match", version: "1", statement_hash: sha("b") }],
    usl: { namespace: "ns", model_version: "v1" },
    list_snapshots: [{ list: "OFAC", snapshot_id: "ofac-1" }],
    queries: [
      {
        query_id: "q1",
        agent: "evidence",
        role: "role_evidence_agent",
        table: "t",
        sql: "SELECT 1",
        sql_hash: sha256Hex("SELECT 1"),
        row_count: 3,
        row_hashes: [sha("c")],
        masked_columns: ["id_number"],
        token_source: "role",
        latency_ms: 40,
        cache_hit: false,
      },
    ],
    memories: [],
    models: [
      {
        agent: "decision",
        model_requested: "meterless/deep",
        model_routed: "nvidia/nemotron-3-ultra-550b-a55b",
        provider: "nightshift",
        route_kind: "cloud",
        thinking: { budgetTokens: 500 },
        tokens_in: 2000,
        tokens_out: 500,
        latency_ms: 20000,
      },
      {
        agent: "critic",
        model_requested: "meterless/judge",
        model_routed: "local",
        provider: "nightshift",
        route_kind: "local",
        thinking: "off",
        tokens_in: 1000,
        tokens_out: 100,
      },
    ],
    guards: [],
    critic: { rounds: 1, final_verdict: "approved" },
    ...over,
  });
}

describe("buildTraceContract", () => {
  it("prices cloud calls from the configured assumptions and local calls at the local rate", () => {
    const t = buildTraceContract(record(), {
      ...costs,
      cloudInputPerMillionTokens: 1,
      cloudOutputPerMillionTokens: 2,
      localPerMillionTokens: 0,
      perDataQuery: 0.01,
    });
    expect(t.cost.models[0]).toMatchObject({
      route_kind: "cloud",
      reasoning: "on (budget 500 tokens)",
      cost: 0.003,
      receipt_status: "none",
    });
    expect(t.cost.models[1]).toMatchObject({ route_kind: "local", reasoning: "off", cost: 0 });
    expect(t.cost.totals).toMatchObject({
      tokens_in: 3000,
      tokens_out: 600,
      cloud_calls: 1,
      local_calls: 1,
      model_cost: 0.003,
      total_cost: 0.013,
    });
    expect(t.cost.data_queries).toMatchObject({ count: 1, total_latency_ms: 40, rows_returned: 3, cache_hits: 0 });
  });

  it("reports the access role, the identity used and masked columns", () => {
    const t = buildTraceContract(record(), costs);
    expect(t.access.by_role).toEqual([
      { role: "role_evidence_agent", queries: 1, token_source: "role", masked_columns: ["id_number"] },
    ]);
    expect(t.record).toMatchObject({ verified: true, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(t.definitions).toEqual([{ definition_id: "true_match", version: "1", statement_hash: sha("b") }]);
  });

  it("marks a query with no recorded identity as unknown, and reasoning 'on' as on", () => {
    const base = record();
    const t = buildTraceContract(
      record({
        queries: [
          {
            ...(base.queries[0] as DecisionRecord["queries"][number]),
            token_source: undefined,
            latency_ms: undefined,
            cache_hit: undefined,
          },
        ],
        models: [
          {
            ...(base.models[0] as DecisionRecord["models"][number]),
            thinking: "on",
            tokens_in: undefined,
            tokens_out: undefined,
          },
        ],
      }),
      costs,
    );
    expect(t.access.by_role[0]?.token_source).toBe("unknown");
    expect(t.cost.models[0]?.reasoning).toBe("on");
    expect(t.cost.models[0]?.cost).toBe(0);
  });

  it("reports a record that does not verify", () => {
    const t = buildTraceContract({ ...record(), rationale: "changed after sealing" }, costs);
    expect(t.record.verified).toBe(false);
  });
});

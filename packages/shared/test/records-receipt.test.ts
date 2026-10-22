import { describe, expect, it } from "vitest";
import { extractReceipt, sealDecisionRecord, sha256Hex, verifyDecisionRecord } from "../src/index.js";
import { signedReceipt } from "./helpers.js";

const sql = "SELECT 1";

function recordWith(receipt: unknown) {
  return sealDecisionRecord({
    record_id: "run-r",
    run_id: "run-r",
    alert_type: "payment",
    alert_ref: "P-1",
    decided_at: "2026-10-23T01:00:00.000Z",
    as_of: "2026-10-23T01:00:00.000Z",
    decision: "ESCALATE_L2",
    confidence: 0.9,
    rationale: "Beneficiary country is on the jurisdiction list.",
    policy: { version: 1, hash: "a".repeat(64) },
    usl: { namespace: "ns", model_version: "v1" },
    list_snapshots: [],
    queries: [
      {
        query_id: "q",
        agent: "evidence",
        role: "role_evidence_agent",
        table: "t",
        sql,
        sql_hash: sha256Hex(sql),
        row_count: 0,
        row_hashes: [],
      },
    ],
    memories: [],
    models: [
      {
        agent: "decision",
        model_requested: "meterless/deep",
        model_routed: "local-runtime/nemotron",
        provider: "nightshift",
        route_kind: "local",
        served_mode: "meterless/auto",
        receipt: receipt as never,
      },
    ],
    guards: [],
    critic: { rounds: 0, final_verdict: "not_run" },
  });
}

describe("receipts in decision records", () => {
  const { envelope } = signedReceipt();
  const summary = extractReceipt({ receipt_id: "rcpt_1", receipt_envelope: envelope })?.summary;

  it("stores the compact receipt with each model call and seals it into the record hash", () => {
    const record = recordWith(summary);
    expect(record.models[0]?.receipt).toMatchObject({ receipt_id: "rcpt_1", verification: "valid_unpinned" });
    expect(record.models[0]?.served_mode).toBe("meterless/auto");
    expect(verifyDecisionRecord(record)).toBe(true);

    const tampered = {
      ...record,
      models: [{ ...record.models[0], receipt: { ...summary, verification: "valid_pinned" } }],
    };
    expect(verifyDecisionRecord(tampered)).toBe(false);
  });

  it("rejects a receipt summary that is incomplete", () => {
    expect(() => recordWith({ receipt_id: "rcpt_1" })).toThrow();
    expect(() => recordWith({ ...summary, verification: "trust-me" })).toThrow();
  });

  it("allows a model call without a receipt (a different provider)", () => {
    expect(recordWith(undefined).models[0]?.receipt).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  appendHumanAction,
  canonicalJson,
  checkPointer,
  compareDecisionRecords,
  type DecisionRecord,
  DecisionRecordSchema,
  DispositionMemorySchema,
  hashRow,
  hashValue,
  type MemoryPointer,
  MemoryPointerSchema,
  memoryUsable,
  ReplayRequestSchema,
  sealDecisionRecord,
  sha256Hex,
  type UnsealedDecisionRecord,
  verifyDecisionRecord,
} from "../src/index.js";
import { first } from "./helpers.js";

const POLICY_HASH = "a".repeat(64);
const row = { customer_id: "C-1", name: "Example Trading LLC", country: "AE" };

function pointer(over: Partial<MemoryPointer> = {}): MemoryPointer {
  return {
    usl_table: "lightning.metastore.sanctions.list_entry",
    row_key: { entry_id: "E-9" },
    content_hash: hashRow(row),
    list_snapshot_id: "ofac-2026-10-22",
    captured_at: "2026-10-22T10:00:00.000Z",
    ...over,
  };
}

const sql = "SELECT entry_id, program FROM lightning.metastore.sanctions.list_entry WHERE entry_id = 'E-9'";

function unsealed(over: Partial<UnsealedDecisionRecord> = {}): UnsealedDecisionRecord {
  return {
    record_id: "run-1",
    run_id: "run-1",
    alert_type: "customer",
    alert_ref: "A-0001",
    decided_at: "2026-10-23T01:00:00.000Z",
    as_of: "2026-10-23T01:00:00.000Z",
    decision: "CLOSE_FALSE_POSITIVE",
    confidence: 0.82,
    rationale: "Date of birth and nationality differ from the list entry.",
    what_would_change: ["A matching passport number"],
    policy: { version: 1, hash: POLICY_HASH },
    usl: { namespace: "lightning.metastore.sanctions", model_version: "screening_usl@3" },
    list_snapshots: [{ list: "OFAC", snapshot_id: "ofac-2026-10-22", content_hash: "b".repeat(64) }],
    queries: [
      {
        query_id: "q-1",
        agent: "evidence",
        role: "role_evidence_agent",
        table: "list_entry",
        sql,
        sql_hash: sha256Hex(sql),
        row_count: 1,
        row_hashes: [hashRow({ entry_id: "E-9" })],
        masked_columns: ["id_number"],
      },
    ],
    memories: [{ memory_id: "mem-1", pointer_states: ["fresh"], used: true }],
    models: [
      {
        agent: "decision",
        model_requested: "meterless/deep",
        model_routed: "local-runtime/nemotron-3.5-lightning-30b-a3b",
        provider: "nightshift",
        route_kind: "local",
        thinking: "off",
        tokens_in: 100,
        tokens_out: 40,
        latency_ms: 1200,
      },
    ],
    guards: [{ guard: "data_quality", verdict: "pass" }],
    critic: { rounds: 1, final_verdict: "approved" },
    human: [],
    ...over,
  };
}

describe("hashing", () => {
  it("is independent of key order and whitespace", () => {
    expect(hashValue({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(hashValue({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(canonicalJson({ b: 1, a: undefined, c: [undefined] })).toBe('{"b":1,"c":[null]}');
  });

  it("differs for different content and rejects values that have no JSON form", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
    expect(() => hashValue({ n: Number.NaN })).toThrow(TypeError);
    expect(() => hashValue({ f: () => 1 })).toThrow(TypeError);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes rows by content, not by column order", () => {
    expect(hashRow({ a: "1", b: "2" })).toBe(hashRow({ b: "2", a: "1" }));
    expect(hashRow({ a: "1" })).not.toBe(hashRow({ a: "2" }));
  });
});

describe("memory pointers", () => {
  it("accepts a pointer and a disposition memory made only of codes and pointers", () => {
    expect(MemoryPointerSchema.safeParse(pointer()).success).toBe(true);
    const memory = {
      memory_id: "mem-1",
      alert_type: "customer",
      decision: "CLOSE_FALSE_POSITIVE",
      reason_codes: ["DOB_MISMATCH", "NATIONALITY_MISMATCH"],
      pointers: [pointer()],
      policy: { version: 1, hash: POLICY_HASH },
      decision_record_hash: "c".repeat(64),
      created_at: "2026-10-23T01:00:00.000Z",
    };
    expect(DispositionMemorySchema.safeParse(memory).success).toBe(true);
  });

  it("rejects free text where a reason code is required, so personal data has no place to hide", () => {
    const memory = {
      memory_id: "mem-1",
      alert_type: "customer",
      decision: "CLOSE_FALSE_POSITIVE",
      reason_codes: ["John Smith born 1971 is not the listed person"],
      pointers: [pointer()],
      policy: { version: 1, hash: POLICY_HASH },
      decision_record_hash: "c".repeat(64),
      created_at: "2026-10-23T01:00:00.000Z",
    };
    expect(DispositionMemorySchema.safeParse(memory).success).toBe(false);
    expect(DispositionMemorySchema.safeParse({ ...memory, reason_codes: [] }).success).toBe(false);
    expect(DispositionMemorySchema.safeParse({ ...memory, pointers: [] }).success).toBe(false);
    expect(DispositionMemorySchema.safeParse({ ...memory, reason_codes: ["OK_CODE"], note: "extra" }).success).toBe(
      false,
    );
  });

  it("requires a key, a real hash and a timestamp", () => {
    expect(MemoryPointerSchema.safeParse(pointer({ row_key: {} })).success).toBe(false);
    expect(MemoryPointerSchema.safeParse(pointer({ content_hash: "xyz" })).success).toBe(false);
    expect(MemoryPointerSchema.safeParse(pointer({ captured_at: "yesterday" })).success).toBe(false);
  });

  it("re-validates against the current row: fresh, stale or missing", () => {
    const p = pointer();
    expect(checkPointer(p, { content_hash: hashRow(row), list_snapshot_id: "ofac-2026-10-22" })).toBe("fresh");
    expect(checkPointer(p, { content_hash: hashRow(row) })).toBe("fresh");
    expect(checkPointer(p, { content_hash: hashRow({ ...row, name: "Changed" }) })).toBe("stale");
    expect(checkPointer(p, { content_hash: hashRow(row), list_snapshot_id: "ofac-2026-10-23" })).toBe("stale");
    expect(checkPointer(p, undefined)).toBe("missing");
    expect(
      checkPointer(pointer({ list_snapshot_id: undefined }), { content_hash: hashRow(row), list_snapshot_id: "x" }),
    ).toBe("fresh");
  });

  it("only lets a memory influence a decision when every pointer is fresh", () => {
    expect(memoryUsable(["fresh", "fresh"])).toBe(true);
    expect(memoryUsable(["fresh", "stale"])).toBe(false);
    expect(memoryUsable(["missing"])).toBe(false);
    expect(memoryUsable([])).toBe(false);
  });
});

describe("decision records", () => {
  it("seals a record with a hash that verifies", () => {
    const record = sealDecisionRecord(unsealed());
    expect(record.schema_version).toBe(1);
    expect(record.record_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyDecisionRecord(record)).toBe(true);
    expect(DecisionRecordSchema.safeParse(record).success).toBe(true);
  });

  it("produces the same hash for the same content", () => {
    expect(sealDecisionRecord(unsealed()).record_hash).toBe(sealDecisionRecord(unsealed()).record_hash);
  });

  it("detects any tampering", () => {
    const record = sealDecisionRecord(unsealed());
    expect(verifyDecisionRecord({ ...record, decision: "ESCALATE_L2" })).toBe(false);
    expect(verifyDecisionRecord({ ...record, confidence: 0.99 })).toBe(false);
    expect(verifyDecisionRecord({ ...record, policy: { version: 2, hash: POLICY_HASH } })).toBe(false);
    expect(verifyDecisionRecord({ ...record, record_hash: "d".repeat(64) })).toBe(false);
    expect(verifyDecisionRecord({ nonsense: true })).toBe(false);
    expect(verifyDecisionRecord(null)).toBe(false);
  });

  it("rejects a query whose SQL does not match its hash", () => {
    const bad = unsealed();
    bad.queries = [{ ...first(bad.queries ?? []), sql: "SELECT 2" }];
    expect(() => sealDecisionRecord(bad)).toThrow();
  });

  it("rejects incomplete or out-of-range records", () => {
    expect(() => sealDecisionRecord(unsealed({ confidence: 1.2 }))).toThrow();
    expect(() => sealDecisionRecord(unsealed({ decision: "AUTO_BLOCK" as never }))).toThrow();
    expect(() => sealDecisionRecord(unsealed({ run_id: "../x" }))).toThrow();
    expect(() => sealDecisionRecord(unsealed({ critic: { rounds: 4, final_verdict: "approved" } }))).toThrow();
  });

  it("records a confidence cap with its reason", () => {
    const record = sealDecisionRecord(
      unsealed({
        confidence: 0.55,
        confidence_cap: { value: 0.55, reason: "date of birth missing in customer record" },
      }),
    );
    expect(record.confidence_cap?.reason).toContain("date of birth");
  });

  it("appends a human action as a new record that points back at the previous hash", () => {
    const original = sealDecisionRecord(unsealed());
    const reviewed = appendHumanAction(
      original,
      { action: "approve", actor: "analyst-1", at: "2026-10-23T02:00:00.000Z", reason: "agree" },
      "run-1-review-1",
    );
    expect(reviewed.previous_record_hash).toBe(original.record_hash);
    expect(reviewed.record_hash).not.toBe(original.record_hash);
    expect(reviewed.human).toHaveLength(1);
    expect(original.human).toHaveLength(0);
    expect(verifyDecisionRecord(reviewed)).toBe(true);
    expect(verifyDecisionRecord(original)).toBe(true);

    const second = appendHumanAction(
      reviewed,
      { action: "second_approval", actor: "reviewer-2", at: "2026-10-23T03:00:00.000Z" },
      "run-1-review-2",
    );
    expect(second.human.map((h) => h.actor)).toEqual(["analyst-1", "reviewer-2"]);
    expect(second.previous_record_hash).toBe(reviewed.record_hash);
  });
});

describe("replay comparison", () => {
  const sealed = (over: Partial<UnsealedDecisionRecord> = {}): DecisionRecord => sealDecisionRecord(unsealed(over));

  it("reports no differences when the outcome and the facts match, ignoring timing and routes", () => {
    const recorded = sealed();
    const replayed = sealed({
      decided_at: "2026-10-30T09:00:00.000Z",
      models: [
        {
          ...first(unsealed().models ?? []),
          model_routed: "nvidia/nemotron-3-super-120b-a12b",
          route_kind: "cloud",
          latency_ms: 9,
        },
      ],
    });
    expect(compareDecisionRecords(recorded, replayed)).toEqual([]);
  });

  it("names every field that changed", () => {
    const recorded = sealed();
    const replayed = sealed({
      decision: "ESCALATE_L2",
      policy: { version: 2, hash: POLICY_HASH },
      list_snapshots: [{ list: "OFAC", snapshot_id: "ofac-2026-10-25" }],
      memories: [{ memory_id: "mem-1", pointer_states: ["stale"], used: false }],
    });
    const fields = compareDecisionRecords(recorded, replayed).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["decision", "policy", "list_snapshots", "memories"]));
    expect(fields).not.toContain("guards");
  });

  it("treats row hashes as a set, so row order does not matter", () => {
    const [h1, h2] = [hashRow({ a: "1" }), hashRow({ a: "2" })] as [string, string];
    const q = (rows: string[]) => ({ ...first(unsealed().queries ?? []), row_count: 2, row_hashes: rows });
    expect(compareDecisionRecords(sealed({ queries: [q([h1, h2])] }), sealed({ queries: [q([h2, h1])] }))).toEqual([]);
    expect(
      compareDecisionRecords(sealed({ queries: [q([h1, h2])] }), sealed({ queries: [q([h1, h1])] })).map(
        (d) => d.field,
      ),
    ).toEqual(["query_rows"]);
  });

  it("validates replay requests", () => {
    expect(ReplayRequestSchema.safeParse({ record_id: "run-1" }).success).toBe(true);
    expect(ReplayRequestSchema.safeParse({ record_id: "run-1", as_of: "2026-10-22T00:00:00Z" }).success).toBe(true);
    expect(ReplayRequestSchema.safeParse({ record_id: "run-1", as_of: "last tuesday" }).success).toBe(false);
    expect(ReplayRequestSchema.safeParse({ record_id: "../x" }).success).toBe(false);
  });
});

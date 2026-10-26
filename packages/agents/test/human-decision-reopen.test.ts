import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Actor,
  type Decision,
  type DecisionRecord,
  loadPolicyFile,
  sealDecisionRecord,
  sha256Hex,
} from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  attempt,
  humanState,
  MAX_REASON_LENGTH,
  needsSecondForClose,
  readActions,
  readAnalystMemory,
  recordDecision,
  reopen,
  secondApproval,
} from "../src/index.js";
import { sampleDeps } from "./helpers.js";

/**
 * The human decision step beyond the first decision: reopening a close the desk made automatically, the upper limit on
 * a reason, how a record's id grows with each action, and what is remembered once a four-eyes override is settled.
 */
const policy = loadPolicyFile("config/policy.default.json");
const analyst: Actor = { id: "ana", role: "analyst", demo: false };
const officer: Actor = { id: "off", role: "approver", demo: false };
const officer2: Actor = { id: "off2", role: "approver", demo: false };
const viewer: Actor = { id: "vie", role: "viewer", demo: false };
const NOW = new Date("2026-10-23T10:00:00.000Z");
const REASON = "The dates of birth conflict and the passport differs.";

function recordFor(decision: Decision, autoClosed = false): DecisionRecord {
  return sealDecisionRecord({
    record_id: "rec-run-1",
    run_id: "run-1",
    alert_type: "customer",
    alert_ref: "ALR-0001",
    decided_at: "2026-10-23T09:00:00.000Z",
    as_of: "2026-10-23T09:00:00.000Z",
    decision,
    confidence: 0.95,
    rationale: "Basis of the recommendation.",
    what_would_change: [],
    policy: { version: policy.version, hash: sha256Hex("policy") },
    definitions: [],
    usl: { namespace: "sanctions", model_version: "1" },
    list_snapshots: [{ list: "OFAC", snapshot_id: "snap-1", content_hash: sha256Hex("entry") }],
    queries: [],
    memories: [],
    models: [],
    guards: [],
    critic: { rounds: 1, final_verdict: "approved" },
    ...(autoClosed
      ? {
          autonomy: {
            policy_level: 1 as const,
            level_in_force: 1 as const,
            outcome: "auto_closed" as const,
            conditions: [],
            qa_draw: 0.5,
            qa_rate: 0.1,
            statement: "closed automatically under policy v9, level 1",
          },
        }
      : {}),
  });
}

describe("reopening a close the desk made automatically", () => {
  const closed = () => recordFor("CLOSE_FALSE_POSITIVE", true);
  const open = (r: DecisionRecord, actor = analyst, over: Partial<{ reason: string; record_hash: string }> = {}) =>
    reopen(r, { reason: REASON, record_hash: r.record_hash, ...over }, actor, NOW);

  it("is the state of an automatic close until a person reopens it", () => {
    expect(humanState(closed())).toEqual({ status: "auto_closed", final: "CLOSE_FALSE_POSITIVE" });
  });

  it("refuses to reopen a recommendation a person is meant to decide", () => {
    expect(() => open(recordFor("CLOSE_FALSE_POSITIVE"))).toThrow(/only a close made automatically can be reopened/);
  });

  it("holds the reopening to the same rules as a decision: who, a reason, the current record", () => {
    expect(() => open(closed(), viewer)).toThrow(/may not record decisions/);
    expect(() => open(closed(), analyst, { reason: "no" })).toThrow(/reason of at least 10/);
    expect(() => open(closed(), analyst, { record_hash: sha256Hex("older") })).toThrow(/changed since you looked/);
  });

  it("puts the case back to awaiting a decision, under the person's id, and cannot be reopened twice", () => {
    const r = closed();
    const next = open(r);
    expect(next.human).toEqual([
      { action: "reopen", actor: "ana", role: "analyst", at: NOW.toISOString(), reason: REASON },
    ]);
    expect(next.previous_record_hash).toBe(r.record_hash);
    expect(next.record_id).toBe("rec-run-1-h1");
    expect(humanState(next)).toEqual({ status: "awaiting" });
    expect(() => open(next)).toThrow(/only a close made automatically/);
    // The case is then decided like any other, and each action adds one to the record's number.
    const decided = recordDecision(
      next,
      { action: "approve", reason: REASON, record_hash: next.record_hash },
      analyst,
      NOW,
    );
    expect(humanState(decided)).toMatchObject({ status: "decided", final: "CLOSE_FALSE_POSITIVE" });
    expect(decided.record_id).toBe("rec-run-1-h2");
  });
});

describe("the reason a person gives", () => {
  const decide = (reason: string) => {
    const r = recordFor("ESCALATE_L2");
    return recordDecision(r, { action: "approve", reason, record_hash: r.record_hash }, analyst, NOW);
  };

  it("may be as long as the limit and no longer", () => {
    expect(decide("x".repeat(MAX_REASON_LENGTH)).human[0]?.reason).toHaveLength(MAX_REASON_LENGTH);
    expect(() => decide("x".repeat(MAX_REASON_LENGTH + 1))).toThrow(
      new RegExp(`longer than ${MAX_REASON_LENGTH} characters`),
    );
  });

  it("is kept without the spaces around it", () => {
    expect(decide(`   ${REASON}   `).human[0]?.reason).toBe(REASON);
  });
});

describe("committing an override to a close", () => {
  const ref = { customerId: "CUST-1", entryId: "OFAC-1" };
  type Stores = { logDir: string; outboxDir: string };
  const setup = (): Stores => {
    const logDir = sampleDeps().logDir;
    const outboxDir = join(logDir, "outbox");
    mkdirSync(outboxDir, { recursive: true });
    return { logDir, outboxDir };
  };
  const audit = (logDir: string) =>
    readFileSync(join(logDir, "decisions", "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, string>);
  const first = (stores: Stores, r: DecisionRecord) =>
    attempt(stores, policy, officer, "decision", r, ref, NOW, () =>
      recordDecision(
        r,
        {
          action: "override",
          outcome: "CLOSE_FALSE_POSITIVE",
          reason: "Different person, checked the passport.",
          record_hash: r.record_hash,
        },
        officer,
        NOW,
      ),
    );
  const second = (stores: Stores, pending: DecisionRecord, approve: boolean) =>
    attempt(stores, policy, officer2, "second_approval", pending, ref, NOW, () =>
      secondApproval(
        pending,
        { approve, reason: "Agree, the passport rules it out.", record_hash: pending.record_hash },
        officer2,
        NOW,
      ),
    );

  it("remembers nothing and prepares nothing while the close waits for the second approver", () => {
    const stores = setup();
    const done = first(stores, recordFor("ESCALATE_L2"));
    expect(done.status).toBe("override_pending");
    expect(done.actions).toEqual([]);
    expect(readAnalystMemory(stores.logDir, "CUST-1", "OFAC-1")).toEqual([]);
    expect(audit(stores.logDir)).toEqual([
      expect.objectContaining({ user: "off", role: "approver", action: "decision", result: "override_pending" }),
    ]);
  });

  it("remembers the close under the second approver once agreed, marked as an override", () => {
    const stores = setup();
    const pending = first(stores, recordFor("ESCALATE_L2"));
    const done = second(stores, pending.record, true);
    expect(done.status).toBe("override_approved");
    expect(done.actions.map((a) => a.body.kind)).toEqual(["closure_note"]);
    expect(readActions(stores.outboxDir, "ALR-0001").map((a) => a.body.kind)).toEqual(["closure_note"]);
    const memory = readAnalystMemory(stores.logDir, "CUST-1", "OFAC-1");
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({
      decision: "CLOSE_FALSE_POSITIVE",
      decided_by: "off2",
      reason_codes: "ANALYST_OVERRIDE",
      reason: "Agree, the passport rules it out.",
      decision_record_hash: done.record.record_hash,
    });
    expect(audit(stores.logDir).map((l) => [l.user, l.result])).toEqual([
      ["off", "override_pending"],
      ["off2", "override_approved"],
    ]);
  });

  it("remembers the escalation instead when the second approver declines", () => {
    const stores = setup();
    const pending = first(stores, recordFor("ESCALATE_L2"));
    const done = second(stores, pending.record, false);
    expect(done.status).toBe("override_declined");
    expect(done.actions.map((a) => a.body.kind)).toEqual(["escalation_ticket"]);
    expect(readAnalystMemory(stores.logDir, "CUST-1", "OFAC-1")[0]).toMatchObject({
      decision: "ESCALATE_L2",
      decided_by: "off2",
      reason_codes: "ANALYST_OVERRIDE",
    });
  });
});

describe("when a close needs a second approver", () => {
  it("is only when a person lowers a more cautious recommendation to a close", () => {
    expect(needsSecondForClose("ESCALATE_L2", "CLOSE_FALSE_POSITIVE")).toBe(true);
    expect(needsSecondForClose("NEED_MORE_INFO", "CLOSE_FALSE_POSITIVE")).toBe(true);
    expect(needsSecondForClose("CLOSE_FALSE_POSITIVE", "CLOSE_FALSE_POSITIVE")).toBe(false);
    expect(needsSecondForClose("ESCALATE_L2", "NEED_MORE_INFO")).toBe(false);
  });
});

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  checkTippingOff,
  humanState,
  loadSigner,
  planActions,
  readActions,
  readAnalystMemory,
  recordDecision,
  rfiText,
  sealAction,
  secondApproval,
  verifyAction,
} from "../src/index.js";
import { sampleDeps } from "./helpers.js";

const policy = loadPolicyFile("config/policy.default.json");
const analyst: Actor = { id: "ana", role: "analyst", demo: false };
const analyst2: Actor = { id: "ana2", role: "analyst", demo: false };
const officer: Actor = { id: "off", role: "approver", demo: false };
const officer2: Actor = { id: "off2", role: "approver", demo: false };
const admin: Actor = { id: "adm", role: "policy_admin", demo: false };
const viewer: Actor = { id: "vie", role: "viewer", demo: false };
const NOW = new Date("2026-10-23T10:00:00.000Z");
const REASON = "The dates of birth conflict and the passport differs.";

function recordFor(
  decision: Decision,
  alertType: "customer" | "payment" = "customer",
  id = "run-1",
  rationale = "Basis of the recommendation.",
): DecisionRecord {
  return sealDecisionRecord({
    record_id: `rec-${id}`,
    run_id: id,
    alert_type: alertType,
    alert_ref: "ALR-0001",
    decided_at: "2026-10-23T09:00:00.000Z",
    as_of: "2026-10-23T09:00:00.000Z",
    decision,
    confidence: 0.9,
    rationale,
    what_would_change: ["A recent proof of address"],
    policy: { version: policy.version, hash: sha256Hex("policy") },
    definitions: [],
    usl: { namespace: "sanctions", model_version: "1" },
    list_snapshots: [{ list: "OFAC", snapshot_id: "snap-1", content_hash: sha256Hex("entry") }],
    queries: [],
    memories: [],
    models: [],
    guards: [],
    critic: { rounds: 1, final_verdict: "approved" },
  });
}

const approve = (r: DecisionRecord, actor = analyst) =>
  recordDecision(r, { action: "approve", reason: REASON, record_hash: r.record_hash }, actor, NOW);

describe("the first decision on a recommendation", () => {
  it("lets an analyst approve it, with a reason, and records who and when", () => {
    const next = approve(recordFor("CLOSE_FALSE_POSITIVE"));
    expect(next.human).toEqual([
      {
        action: "approve",
        actor: "ana",
        role: "analyst",
        at: NOW.toISOString(),
        reason: REASON,
        outcome: "CLOSE_FALSE_POSITIVE",
      },
    ]);
    expect(next.previous_record_hash).toBeDefined();
    expect(humanState(next)).toMatchObject({ status: "decided", final: "CLOSE_FALSE_POSITIVE" });
  });

  it("refuses a viewer and a policy admin", () => {
    const r = recordFor("CLOSE_FALSE_POSITIVE");
    for (const who of [viewer, admin]) expect(() => approve(r, who)).toThrow(/may not record decisions/);
  });

  it.each(["", "   ", "too short"])("refuses a reason that is missing or too short: %j", (reason) => {
    const r = recordFor("CLOSE_FALSE_POSITIVE");
    expect(() => recordDecision(r, { action: "approve", reason, record_hash: r.record_hash }, analyst, NOW)).toThrow(
      /reason of at least 10/,
    );
  });

  it("refuses a decision about a recommendation that is no longer the latest", () => {
    const r = recordFor("CLOSE_FALSE_POSITIVE");
    expect(() =>
      recordDecision(r, { action: "approve", reason: REASON, record_hash: sha256Hex("older") }, analyst, NOW),
    ).toThrow(/changed since you looked/);
  });

  it("refuses to decide the same recommendation twice", () => {
    const decided = approve(recordFor("ESCALATE_L2"));
    expect(() =>
      recordDecision(decided, { action: "approve", reason: REASON, record_hash: decided.record_hash }, officer, NOW),
    ).toThrow(/already been decided/);
  });

  it("needs an override to name a different outcome", () => {
    const r = recordFor("ESCALATE_L2");
    const base = { action: "override" as const, reason: REASON, record_hash: r.record_hash };
    expect(() => recordDecision(r, base, officer, NOW)).toThrow(/names the outcome/);
    expect(() => recordDecision(r, { ...base, outcome: "ESCALATE_L2" }, officer, NOW)).toThrow(/different outcome/);
    expect(() =>
      recordDecision(
        r,
        { action: "approve", outcome: "NEED_MORE_INFO", reason: REASON, record_hash: r.record_hash },
        officer,
        NOW,
      ),
    ).toThrow(/use override/);
  });

  it("lets an analyst override towards more caution but only an approver towards less", () => {
    const r = recordFor("CLOSE_FALSE_POSITIVE");
    const more = recordDecision(
      r,
      { action: "override", outcome: "ESCALATE_L2", reason: REASON, record_hash: r.record_hash },
      analyst,
      NOW,
    );
    expect(humanState(more)).toMatchObject({ status: "decided", final: "ESCALATE_L2" });

    const e = recordFor("ESCALATE_L2");
    const less = {
      action: "override" as const,
      outcome: "CLOSE_FALSE_POSITIVE" as const,
      reason: REASON,
      record_hash: e.record_hash,
    };
    expect(() => recordDecision(e, less, analyst, NOW)).toThrow(
      /only an approver may override towards a less cautious/,
    );
    // Towards a close it is not final on one approver's word: it waits for a second, different approver.
    expect(humanState(recordDecision(e, less, officer, NOW))).toMatchObject({ status: "override_pending" });
  });
});

describe("an override that lowers caution to a close (four eyes)", () => {
  const overrideToClose = (from: Decision) => {
    const r = recordFor(from, "payment");
    return recordDecision(
      r,
      { action: "override", outcome: "CLOSE_FALSE_POSITIVE", reason: REASON, record_hash: r.record_hash },
      officer,
      NOW,
    );
  };

  it.each(["ESCALATE_L2", "RECOMMEND_BLOCK", "NEED_MORE_INFO"] as const)(
    "waits for a second approver after an override from %s to a close, and prepares nothing yet",
    (from) => {
      const pending = overrideToClose(from);
      expect(humanState(pending)).toEqual({ status: "override_pending", first: pending.human[0] });
      expect(planActions(pending, policy, NOW)).toEqual([]);
    },
  );

  it("refuses a second approval by the same person", () => {
    const pending = overrideToClose("ESCALATE_L2");
    expect(() =>
      secondApproval(pending, { approve: true, reason: REASON, record_hash: pending.record_hash }, officer, NOW),
    ).toThrow(/different person/);
  });

  it("refuses a second approval by someone who is not an approver", () => {
    const pending = overrideToClose("ESCALATE_L2");
    expect(() =>
      secondApproval(pending, { approve: true, reason: REASON, record_hash: pending.record_hash }, analyst2, NOW),
    ).toThrow(/override to a close must come from an approver/);
  });

  it("closes once a second, different approver agrees, and prepares the closure note", () => {
    const pending = overrideToClose("ESCALATE_L2");
    const done = secondApproval(
      pending,
      { approve: true, reason: REASON, record_hash: pending.record_hash },
      officer2,
      NOW,
    );
    expect(humanState(done)).toMatchObject({ status: "override_approved", final: "CLOSE_FALSE_POSITIVE" });
    expect(planActions(done, policy, NOW).map((a) => a.kind)).toEqual(["closure_note"]);
  });

  it("names both approvers in the closure note, rests it on their reasons and says the desk's view apart, in words", () => {
    const r = recordFor(
      "ESCALATE_L2",
      "customer",
      "run-1",
      "Rules-based sample answer. Name is weak, date of birth is missing_customer, nationality is conflict.",
    );
    const pending = recordDecision(
      r,
      {
        action: "override",
        outcome: "CLOSE_FALSE_POSITIVE",
        reason: "Different person, checked the passport.",
        record_hash: r.record_hash,
      },
      officer,
      NOW,
    );
    const done = secondApproval(
      pending,
      { approve: true, reason: "Agree, the passport rules it out.", record_hash: pending.record_hash },
      officer2,
      NOW,
    );
    const note = planActions(done, policy, NOW)[0]?.content ?? "";
    expect(note).toContain("closed as a false positive by off, second approval by off2.");
    expect(note).toContain(
      "Basis: off: Different person, checked the passport; off2: Agree, the passport rules it out.",
    );
    expect(note).toContain("The desk had recommended Escalate to level 2 because:");
    expect(note).toContain("date of birth: customer has no date of birth on record, nationality: conflicts");
    expect(note).not.toMatch(/missing_customer|\bconflict\b|ESCALATE_L2|CLOSE_FALSE_POSITIVE|_/);
  });

  const CODED = "Rules-based sample answer. Name is weak, date of birth is missing_customer, nationality is conflict.";
  const noCodes = (text: string) =>
    expect(text).not.toMatch(/missing_customer|is conflict|ESCALATE_L2|CLOSE_FALSE_POSITIVE|RECOMMEND_BLOCK|_/);

  it("names both people in the escalation after a declined close, with both reasons and the desk's view apart", () => {
    const r = recordFor("ESCALATE_L2", "customer", "run-1", CODED);
    const pending = recordDecision(
      r,
      {
        action: "override",
        outcome: "CLOSE_FALSE_POSITIVE",
        reason: "Looks like a different person.",
        record_hash: r.record_hash,
      },
      officer,
      NOW,
    );
    const done = secondApproval(
      pending,
      { approve: false, reason: "The passport is not checked yet.", record_hash: pending.record_hash },
      officer2,
      NOW,
    );
    const ticket = planActions(done, policy, NOW)[0];
    expect(ticket?.status).toBe("escalated after the close was declined");
    expect(ticket?.content).toContain(
      "was escalated to level 2: off overrode it to a close, and off2, the second approver, declined the close.",
    );
    expect(ticket?.content).toContain(
      "Basis: off: Looks like a different person; off2: The passport is not checked yet.",
    );
    expect(ticket?.content).toContain("The desk had recommended Escalate to level 2 because:");
    noCodes(ticket?.content ?? "");
  });

  it("an approved escalation names the person, rests on their reason and gives the desk's reason in words", () => {
    const r = recordFor("ESCALATE_L2", "customer", "run-1", CODED);
    const ticket = planActions(approve(r), policy, NOW)[0];
    expect(ticket?.content).toContain(`was escalated to level 2 by ana. Basis: ana: ${REASON}`);
    expect(ticket?.content).toContain("nationality: conflicts");
    noCodes(ticket?.content ?? "");
  });

  it("a declined block names both approvers; a pending block names the first", () => {
    const r = recordFor("RECOMMEND_BLOCK", "customer", "run-1", CODED);
    const first = approve(r, officer);
    const pending = planActions(first, policy, NOW)[0]?.content ?? "";
    expect(pending).toContain("has one approval, from off.");
    expect(pending).toContain("Basis: off:");
    noCodes(pending);
    const done = secondApproval(
      first,
      { approve: false, reason: "Not enough for a block.", record_hash: first.record_hash },
      officer2,
      NOW,
    );
    const ticket = planActions(done, policy, NOW)[0];
    expect(ticket?.status).toBe("escalated after the block was declined");
    expect(ticket?.content).toContain("off approved a block, and off2, the second approver, declined the block.");
    noCodes(ticket?.content ?? "");
  });

  it("escalates when the second approver declines", () => {
    const pending = overrideToClose("RECOMMEND_BLOCK");
    const done = secondApproval(
      pending,
      { approve: false, reason: REASON, record_hash: pending.record_hash },
      officer2,
      NOW,
    );
    expect(humanState(done)).toMatchObject({ status: "override_declined", final: "ESCALATE_L2" });
    expect(planActions(done, policy, NOW).map((a) => a.kind)).toEqual(["escalation_ticket", "hold_instruction"]);
  });

  it("does not need a second person for an override towards more caution", () => {
    const r = recordFor("CLOSE_FALSE_POSITIVE");
    const more = recordDecision(
      r,
      { action: "override", outcome: "ESCALATE_L2", reason: REASON, record_hash: r.record_hash },
      analyst,
      NOW,
    );
    expect(humanState(more)).toMatchObject({ status: "decided", final: "ESCALATE_L2" });
  });
});

describe("a block", () => {
  const blockRecord = () => recordFor("RECOMMEND_BLOCK");

  it("is not final after one approval: it waits for a second, different approver", () => {
    const first = approve(blockRecord());
    expect(humanState(first)).toMatchObject({ status: "block_pending" });
    expect(humanState(first).final).toBeUndefined();
    const chosen = recordFor("ESCALATE_L2");
    const viaOverride = recordDecision(
      chosen,
      { action: "override", outcome: "RECOMMEND_BLOCK", reason: REASON, record_hash: chosen.record_hash },
      analyst,
      NOW,
    );
    expect(humanState(viaOverride).status).toBe("block_pending");
  });

  const second = (r: DecisionRecord, actor: Actor, ok = true) =>
    secondApproval(r, { approve: ok, reason: REASON, record_hash: r.record_hash }, actor, NOW);

  it("refuses self-approval, and refuses a second approver who is not an approver", () => {
    const first = approve(blockRecord(), officer);
    expect(() => second(first, officer)).toThrow(/different person/);
    expect(() => second(first, analyst2)).toThrow(/must come from an approver/);
    expect(() => second(first, admin)).toThrow(/may not record decisions/);
  });

  it("is confirmed by a different approver", () => {
    const done = second(approve(blockRecord(), analyst), officer);
    expect(humanState(done)).toMatchObject({ status: "block_approved", final: "RECOMMEND_BLOCK" });
    expect(done.human.map((h) => h.actor)).toEqual(["ana", "off"]);
  });

  it("goes back to an escalation when the second approver declines", () => {
    const done = second(approve(blockRecord(), analyst), officer, false);
    expect(humanState(done)).toMatchObject({ status: "block_declined", final: "ESCALATE_L2" });
  });

  it("cannot be confirmed when nothing is waiting, or twice", () => {
    expect(() => second(blockRecord(), officer)).toThrow(/not waiting for a second approval/);
    const done = second(approve(blockRecord(), analyst), officer);
    expect(() => second(done, officer2)).toThrow(/not waiting for a second approval/);
  });

  it("needs the second approver to be looking at the current record", () => {
    const first = approve(blockRecord());
    expect(() =>
      secondApproval(first, { approve: true, reason: REASON, record_hash: sha256Hex("old") }, officer, NOW),
    ).toThrow(/changed since you looked/);
  });
});

describe("the next action is prepared only after a decision", () => {
  const kinds = (r: DecisionRecord, p = policy) => planActions(r, p, NOW).map((a) => a.kind);

  it("prepares nothing while the recommendation is undecided", () => {
    expect(kinds(recordFor("CLOSE_FALSE_POSITIVE"))).toEqual([]);
  });

  it("prepares a closure note, an escalation ticket or an RFI draft for the settled outcome", () => {
    expect(kinds(approve(recordFor("CLOSE_FALSE_POSITIVE")))).toEqual(["closure_note"]);
    expect(kinds(approve(recordFor("ESCALATE_L2")))).toEqual(["escalation_ticket"]);
    expect(kinds(approve(recordFor("NEED_MORE_INFO")))).toEqual(["rfi_draft"]);
  });

  it("adds a draft hold instruction for a payment that is escalated", () => {
    expect(kinds(approve(recordFor("ESCALATE_L2", "payment")))).toEqual(["escalation_ticket", "hold_instruction"]);
    expect(kinds(approve(recordFor("CLOSE_FALSE_POSITIVE", "payment")))).toEqual(["closure_note"]);
  });

  it("marks a block with one approval as 'block approval pending' and prepares no block recommendation", () => {
    const plan = planActions(approve(recordFor("RECOMMEND_BLOCK")), policy, NOW);
    expect(plan.map((a) => [a.kind, a.status])).toEqual([["escalation_ticket", "block approval pending"]]);
  });

  it("prepares a block recommendation for the sanctions officer only after the second approval", () => {
    const first = approve(recordFor("RECOMMEND_BLOCK", "payment"));
    const done = secondApproval(first, { approve: true, reason: REASON, record_hash: first.record_hash }, officer, NOW);
    const plan = planActions(done, policy, NOW);
    expect(plan.map((a) => a.kind)).toEqual(["block_recommendation", "hold_instruction"]);
    expect(plan[0]?.status).toBe("ready for the sanctions officer");
    expect(plan.every((a) => a.sent === false)).toBe(true);
  });

  it("writes a request for information from fixed neutral wording that passes the tipping-off check", () => {
    for (const type of ["customer", "payment"] as const) {
      const { text, check } = rfiText(policy, type);
      expect(check).toEqual({ passed: true, hits: [] });
      expect(text).not.toMatch(/sanction|screening|list|match|block|escalat|alert/i);
    }
    expect(rfiText(policy, "customer").text).toContain("proof of identity");
    expect(rfiText(policy, "payment").text).toContain("purpose of the payment");
  });

  it("never puts the model's what-would-change text into the draft", () => {
    const record = recordFor("NEED_MORE_INFO");
    const leaky = {
      ...record,
      what_would_change: [
        "If the listed party had a date of birth matching the customer's to the day and a matching nationality, true_match could be met, leading to RECOMMEND_BLOCK",
      ],
    };
    const draft = planActions(approve(leaky), policy, NOW).find((a) => a.kind === "rfi_draft");
    expect(draft?.content).not.toContain("listed party");
    expect(draft?.content).not.toContain("RECOMMEND_BLOCK");
    expect(draft).toMatchObject({ needs_approval: true, tipping_off_check: { passed: true } });
    expect(draft?.status).toContain("a person must approve");
  });

  it("catches wording the policy's own patterns missed", () => {
    const missed = [
      "If the listed party had a date of birth matching the customer's to the day, leading to RECOMMEND_BLOCK",
      "Your account was flagged and escalated for review",
      "We may hold your payment while we complete compliance checks",
      "A different nationality for the customer that is not a nationality of the listed party",
    ];
    for (const text of missed) {
      expect(policy.guards.tippingOffPatterns.some((p) => new RegExp(p, "iu").test(text))).toBe(false);
      expect(checkTippingOff(policy, text).passed).toBe(false);
    }
    expect(checkTippingOff(policy, "Please send a recent proof of address.").passed).toBe(true);
  });

  it("withholds a draft whose wording fails the check, and says why", () => {
    const strict = { ...policy, guards: { ...policy.guards, tippingOffPatterns: ["proof of identity"] } };
    const draft = planActions(approve(recordFor("NEED_MORE_INFO")), strict, NOW).find((a) => a.kind === "rfi_draft");
    expect(draft?.status).toBe("draft withheld: the wording failed the tipping-off check");
    expect(draft?.content).not.toContain("Thank you for banking");
    expect(draft?.tipping_off_check).toEqual({ passed: false, hits: ["proof of identity"] });
  });
});

describe("how the prepared records are sealed", () => {
  const body = () => {
    const first = planActions(approve(recordFor("CLOSE_FALSE_POSITIVE")), policy, NOW)[0];
    if (!first) throw new Error("no action was planned");
    return first;
  };
  const keyFile = (dir: string) => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const file = join(dir, "signing.pem");
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }));
    return file;
  };

  it("hash-seals the record, and says so, when no signing key is configured", () => {
    const sealed = sealAction(body(), "a-1");
    expect(sealed.seal).toEqual({ type: "hash-sealed" });
    expect(verifyAction(sealed)).toBe("hash_sealed");
  });

  it("signs with the configured Ed25519 key, and checks the signature against a pinned public key", () => {
    const d = sampleDeps().logDir;
    const signer = loadSigner(keyFile(d));
    expect(signer).toBeDefined();
    const sealed = sealAction(body(), "a-1", signer);
    expect(sealed.seal.type).toBe("ed25519");
    expect(verifyAction(sealed)).toBe("signed_unpinned");
    expect(verifyAction(sealed, signer?.publicKey)).toBe("signed_and_pinned");
    expect(verifyAction(sealed, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")).toBe("signed_unpinned");
  });

  it("detects a record whose content was changed after sealing", () => {
    const signer = loadSigner(keyFile(sampleDeps().logDir));
    for (const s of [undefined, signer]) {
      const sealed = sealAction(body(), "a-1", s);
      expect(verifyAction({ ...sealed, body: { ...sealed.body, final: "ESCALATE_L2" } })).toBe("invalid");
    }
  });

  it("refuses a signing key that is not Ed25519, or a missing file", () => {
    expect(() => loadSigner("/no/such/file.pem")).toThrow(/does not exist/);
    const dir = sampleDeps().logDir;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = join(dir, "rsa.pem");
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }));
    expect(() => loadSigner(file)).toThrow(/Ed25519/);
  });
});

describe("committing a decision", () => {
  const ref = { customerId: "CUST-1", entryId: "OFAC-1" };
  const setup = () => {
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

  it("writes the extended record, the action records, the memory row and an audit line under the person's id", () => {
    const stores = setup();
    const r = recordFor("CLOSE_FALSE_POSITIVE");
    const done = attempt(stores, policy, analyst, "decision", r, ref, NOW, () => approve(r));
    expect(done.status).toBe("decided");
    expect(existsSync(join(stores.logDir, "records", `${done.record.record_id}.json`))).toBe(true);
    expect(readActions(stores.outboxDir, "ALR-0001").map((a) => a.body.kind)).toEqual(["closure_note"]);
    const memory = readAnalystMemory(stores.logDir, "CUST-1", "OFAC-1");
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({
      decision: "CLOSE_FALSE_POSITIVE",
      decided_by: "ana",
      entry_content_hash: sha256Hex("entry"),
      reason_codes: "ANALYST_APPROVE",
    });
    expect(audit(stores.logDir)).toEqual([
      expect.objectContaining({ user: "ana", role: "analyst", action: "decision", result: "decided" }),
    ]);
  });

  it("remembers nothing and prepares only a pending ticket while a block waits for its second approval", () => {
    const stores = setup();
    const r = recordFor("RECOMMEND_BLOCK");
    const done = attempt(stores, policy, analyst, "decision", r, ref, NOW, () => approve(r));
    expect(done.status).toBe("block_pending");
    expect(readActions(stores.outboxDir, "ALR-0001").map((a) => a.body.status)).toEqual(["block approval pending"]);
    expect(readAnalystMemory(stores.logDir, "CUST-1", "OFAC-1")).toEqual([]);
  });

  it("logs a refused attempt too, with the person's id and the reason, and writes nothing else", () => {
    const stores = setup();
    const r = recordFor("RECOMMEND_BLOCK");
    const first = attempt(stores, policy, analyst, "decision", r, ref, NOW, () => approve(r));
    expect(() =>
      attempt(stores, policy, analyst, "second_approval", first.record, ref, NOW, () =>
        secondApproval(
          first.record,
          { approve: true, reason: REASON, record_hash: first.record.record_hash },
          analyst,
          NOW,
        ),
      ),
    ).toThrow(/different person|approver/);
    const last = audit(stores.logDir).at(-1);
    expect(last).toMatchObject({ user: "ana", action: "second_approval", result: "refused" });
    expect(last?.reason).toMatch(/approver|different/);
    expect(readActions(stores.outboxDir, "ALR-0001")).toHaveLength(1);
  });
});

describe("a note's basis", () => {
  it("never doubles the full stop after a person's reason", () => {
    const r = recordFor("ESCALATE_L2");
    const done = recordDecision(
      r,
      { action: "approve", reason: "Passed to the sanctions officer.", record_hash: r.record_hash },
      analyst,
      NOW,
    );
    const note = planActions(done, policy, NOW)[0]?.content ?? "";
    expect(note).toContain("ana: Passed to the sanctions officer.");
    expect(note).not.toContain("..");
  });
});

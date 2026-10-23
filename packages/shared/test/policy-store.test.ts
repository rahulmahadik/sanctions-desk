import { describe, expect, it } from "vitest";
import { type AppError, loadPolicyFile, type Policy, type PolicyChange, PolicyStore } from "../src/index.js";
import { type Editor, policyJson } from "./helpers.js";

const base = (): Policy => ({ ...loadPolicyFile("config/policy.default.json"), version: 1 });
const candidate = (edit?: (e: Editor) => void) => policyJson(edit);

function fixedClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 23, 0, 0, n++));
}

const refuse = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected the call to throw");
};

describe("PolicyStore", () => {
  it("starts with the initial policy active and audited", () => {
    const store = new PolicyStore(base(), { now: fixedClock(), bootstrapActor: "boot" });
    expect(store.activeVersion()).toBe(1);
    expect(store.active().name).toBe("Default screening policy");
    expect(store.audit()).toEqual([
      { ts: "2026-10-23T00:00:00.000Z", actor: "boot", action: "bootstrapped", version: 1 },
    ]);
  });

  it("returns a deeply frozen policy that cannot be changed in place", () => {
    const active = new PolicyStore(base()).active();
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.ownership)).toBe(true);
    expect(Object.isFrozen(active.jurisdictions)).toBe(true);
    expect(() => {
      (active.ownership as { thresholdPercent: number }).thresholdPercent = 10;
    }).toThrow(TypeError);
  });

  it("creates drafts with the next version, ignoring the version in the candidate", () => {
    const store = new PolicyStore(base());
    const draft = store.createDraft(
      candidate((e) => e.set("version", 99)),
      "alice",
      "tighten ownership",
    );
    expect(draft.policy.version).toBe(2);
    expect(draft.status).toBe("draft");
    expect(draft.reason).toBe("tighten ownership");
    expect(store.activeVersion()).toBe(1);
    expect(store.createDraft(candidate(), "alice").policy.version).toBe(3);
  });

  it("rejects invalid drafts with per-field issues and records nothing", () => {
    const store = new PolicyStore(base());
    const error = refuse(() =>
      store.createDraft(
        candidate((e) => e.set("automation.autoBlock", true)),
        "alice",
      ),
    );
    expect(error.type).toBe("validation");
    expect(JSON.stringify(error.details)).toContain("automation.autoBlock");
    expect(store.list()).toHaveLength(1);
    expect(refuse(() => store.createDraft("not an object", "alice")).type).toBe("validation");
  });

  it("requires a named proposer and approver", () => {
    const store = new PolicyStore(base());
    expect(refuse(() => store.createDraft(candidate(), "   ")).message).toContain("proposer");
    store.createDraft(candidate(), "alice");
    expect(refuse(() => store.publish(2, "")).message).toContain("approver");
  });

  it("refuses to publish when the approver is the proposer (four-eyes) and logs the refusal", () => {
    const store = new PolicyStore(base());
    store.createDraft(candidate(), "alice");
    const error = refuse(() => store.publish(2, "alice"));
    expect(error.message).toContain("second person");
    expect(store.activeVersion()).toBe(1);
    expect(store.audit().at(-1)).toMatchObject({ action: "publish_refused", actor: "alice", version: 2 });
  });

  it("publishes with a different approver: hot swap, retire the old version, notify listeners", () => {
    const store = new PolicyStore(base(), { now: fixedClock() });
    const seen: PolicyChange[] = [];
    store.subscribe((c) => seen.push(c));
    store.createDraft(
      candidate((e) => e.set("ownership.thresholdPercent", 40)),
      "alice",
    );

    const change = store.publish(2, "bob");

    expect(store.activeVersion()).toBe(2);
    expect(store.active().ownership.thresholdPercent).toBe(40);
    expect(store.get(1)?.status).toBe("retired");
    expect(store.get(2)).toMatchObject({ status: "active", proposedBy: "alice", approvedBy: "bob" });
    expect(change).toMatchObject({ type: "published", version: 2, previousVersion: 1 });
    expect(change.ref.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(seen).toEqual([change]);
    expect(store.audit().map((a) => a.action)).toEqual(["bootstrapped", "draft_created", "published"]);
  });

  it("does not change a run that already pinned the earlier policy", () => {
    const store = new PolicyStore(base());
    const pinned = store.active();
    store.createDraft(
      candidate((e) => e.set("ownership.thresholdPercent", 30)),
      "alice",
    );
    store.publish(2, "bob");
    expect(pinned.version).toBe(1);
    expect(pinned.ownership.thresholdPercent).toBe(50);
    expect(store.active().ownership.thresholdPercent).toBe(30);
  });

  it("only publishes drafts, and each draft once", () => {
    const store = new PolicyStore(base());
    store.createDraft(candidate(), "alice");
    store.publish(2, "bob");
    expect(refuse(() => store.publish(2, "carol")).message).toContain("not a draft");
    expect(refuse(() => store.publish(1, "carol")).message).toContain("not a draft");
    expect(refuse(() => store.publish(42, "carol")).message).toContain("does not exist");
  });

  it("discards drafts so they can no longer be published", () => {
    const store = new PolicyStore(base());
    store.createDraft(candidate(), "alice");
    store.discardDraft(2, "alice");
    expect(store.get(2)?.status).toBe("discarded");
    expect(refuse(() => store.publish(2, "bob")).message).toContain("not a draft");
    expect(refuse(() => store.discardDraft(1, "alice")).message).toContain("not a draft");
  });

  it("rolls back by copying an old version into a new draft that still needs a second approver", () => {
    const store = new PolicyStore(base());
    store.createDraft(
      candidate((e) => e.set("ownership.thresholdPercent", 40)),
      "alice",
    );
    store.publish(2, "bob");

    const draft = store.rollback(1, "carol");
    expect(draft.policy.version).toBe(3);
    expect(draft.policy.ownership.thresholdPercent).toBe(50);
    expect(draft.rollbackOf).toBe(1);
    expect(draft.reason).toBe("rollback to version 1");
    expect(store.activeVersion()).toBe(2);

    expect(refuse(() => store.publish(3, "carol")).message).toContain("second person");
    store.publish(3, "dave");
    expect(store.active().ownership.thresholdPercent).toBe(50);
    expect(store.get(2)?.status).toBe("retired");
  });

  it("cannot roll back to an unknown, draft or discarded version", () => {
    const store = new PolicyStore(base());
    store.createDraft(candidate(), "alice");
    expect(refuse(() => store.rollback(9, "bob")).message).toContain("does not exist");
    expect(refuse(() => store.rollback(2, "bob")).message).toContain("never published");
  });

  it("lists versions in order", () => {
    const store = new PolicyStore(base());
    store.createDraft(candidate(), "alice");
    expect(store.list().map((r) => r.policy.version)).toEqual([1, 2]);
    expect(store.get(7)).toBeUndefined();
  });

  it("stops notifying after unsubscribe and isolates failing listeners", () => {
    const errors: unknown[] = [];
    const store = new PolicyStore(base(), { onListenerError: (e) => errors.push(e) });
    const seen: number[] = [];
    const unsubscribe = store.subscribe((c) => seen.push(c.version));
    store.subscribe(() => {
      throw new Error("bad listener");
    });
    store.createDraft(candidate(), "alice");
    store.publish(2, "bob");
    expect(seen).toEqual([2]);
    expect(errors).toHaveLength(1);
    expect(store.activeVersion()).toBe(2);

    unsubscribe();
    store.createDraft(candidate(), "alice");
    store.publish(3, "bob");
    expect(seen).toEqual([2]);
  });

  it("survives an error hook that itself throws", () => {
    const store = new PolicyStore(base(), {
      onListenerError: () => {
        throw new Error("hook failed");
      },
    });
    store.subscribe(() => {
      throw new Error("bad listener");
    });
    store.createDraft(candidate(), "alice");
    expect(() => store.publish(2, "bob")).not.toThrow();
    expect(store.activeVersion()).toBe(2);
  });
});

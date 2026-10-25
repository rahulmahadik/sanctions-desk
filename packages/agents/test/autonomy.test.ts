import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GuardVerdictInput, loadPolicyFile, type Policy, PolicySchema } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  type AutonomyInput,
  autonomyUsage,
  decideAutonomy,
  killSwitchOn,
  readKillSwitch,
  setKillSwitch,
} from "../src/index.js";

const base = loadPolicyFile("config/policy.default.json");
const levelOne = (over: Partial<Policy["autonomy"]["autoClose"]> = {}, level: 0 | 1 = 1): Policy => ({
  ...base,
  autonomy: { ...base.autonomy, level, autoClose: { ...base.autonomy.autoClose, ...over } },
});
const pass = (guard: string): GuardVerdictInput => ({ guard, verdict: "pass" });

/** An input that meets every condition; each test then breaks exactly one. */
const clean = (over: Partial<AutonomyInput> = {}): AutonomyInput => ({
  policy: levelOne(),
  killSwitch: false,
  final: "CLOSE_FALSE_POSITIVE",
  modelDecision: "CLOSE_FALSE_POSITIVE",
  firstFinding: { decision: "CLOSE_FALSE_POSITIVE", settled: true },
  confidence: 0.95,
  critic: { final_verdict: "approved" },
  guards: [pass("evidence_standard"), pass("challenger"), pass("data_quality")],
  dataQualityFailed: false,
  screener: { status: "ok", signals: 0, servedByCloud: false, truncated: false },
  autoClosedToday: 0,
  draw: 0.99,
  ...over,
});

describe("automatic closing at level 1", () => {
  it("closes automatically when every condition holds, and says under which policy and why", () => {
    const r = decideAutonomy(clean());
    expect(r.outcome).toBe("auto_closed");
    expect(r.level_in_force).toBe(1);
    expect(r.statement).toMatch(
      /^closed automatically under policy v\d+, level 1, conditions met: level_one, outcome_is_close/,
    );
    expect(r.conditions.every((c) => c.met)).toBe(true);
  });

  // One test per condition: with that one condition broken the close goes to a person.
  it.each<[string, Partial<AutonomyInput>]>([
    ["the policy is at level 0", { policy: levelOne({}, 0) }],
    ["the kill switch is on", { killSwitch: true }],
    ["the first finding from code is not a close", { firstFinding: { decision: "ESCALATE_L2", settled: true } }],
    [
      "the first finding from code is not settled",
      { firstFinding: { decision: "CLOSE_FALSE_POSITIVE", settled: false } },
    ],
    ["there is no first finding", { firstFinding: undefined }],
    ["the decision agent did not recommend a close", { modelDecision: "ESCALATE_L2" }],
    ["the critic did not approve", { critic: { final_verdict: "escalated" } }],
    ["the critic did not run", { critic: { final_verdict: "not_run" } }],
    [
      "the challenger found a credible argument",
      { guards: [pass("evidence_standard"), { guard: "challenger", verdict: "block" }] },
    ],
    ["the evidence standard is not met", { guards: [{ guard: "evidence_standard", verdict: "block" }] }],
    ["the evidence standard verdict is missing", { guards: [pass("challenger")] }],
    ["a data-quality rule fails", { dataQualityFailed: true }],
    [
      "the policy guard raised something",
      { guards: [pass("evidence_standard"), { guard: "jurisdiction", verdict: "block" }] },
    ],
    ["the confidence is below the policy line", { confidence: 0.89 }],
    ["there is no screener result", { screener: undefined }],
    ["the screener failed", { screener: { status: "failed", signals: 0, servedByCloud: false, truncated: false } }],
    [
      "the screener recorded a signal",
      { screener: { status: "ok", signals: 1, servedByCloud: false, truncated: false } },
    ],
    [
      "the screener was served by a cloud route",
      { screener: { status: "ok", signals: 0, servedByCloud: true, truncated: false } },
    ],
    [
      "part of the free text was not read",
      { screener: { status: "ok", signals: 0, servedByCloud: false, truncated: true } },
    ],
  ])("goes to a person when %s", (_name, over) => {
    const r = decideAutonomy(clean(over));
    expect(r.outcome).toBe("human_review");
    expect(r.statement).toBeUndefined();
    expect(r.conditions.some((c) => !c.met)).toBe(true);
  });

  it("accepts a challenger that did not need to run, and one that ran and passed", () => {
    expect(decideAutonomy(clean({ guards: [pass("evidence_standard")] })).outcome).toBe("auto_closed");
    expect(decideAutonomy(clean({ guards: [pass("evidence_standard"), pass("challenger")] })).outcome).toBe(
      "auto_closed",
    );
  });

  it("uses the confidence line of the policy, inclusive", () => {
    expect(decideAutonomy(clean({ confidence: 0.9 })).outcome).toBe("auto_closed");
    expect(decideAutonomy(clean({ policy: levelOne({ confidenceAtLeast: 0.97 }), confidence: 0.95 })).outcome).toBe(
      "human_review",
    );
  });
});

describe("what level 1 never does: the locks", () => {
  it.each(["ESCALATE_L2", "NEED_MORE_INFO", "RECOMMEND_BLOCK"] as const)(
    "never closes automatically when the recommendation is %s, whatever else holds",
    (final) => {
      const r = decideAutonomy(clean({ final, modelDecision: final, confidence: 1 }));
      expect(r.outcome).toBe("human_review");
      expect(r.conditions.find((c) => c.name === "outcome_is_close")?.met).toBe(false);
    },
  );

  it("cannot be loosened by a policy: the locks are fixed in the schema", () => {
    for (const lock of ["escalationsAlwaysToPerson", "moreInfoAlwaysToPerson", "blockNeedsTwoApprovers"] as const) {
      const draft = structuredClone(base) as Record<string, unknown>;
      (draft.autonomy as Record<string, unknown>)[lock] = false;
      expect(PolicySchema.safeParse(draft).success, lock).toBe(false);
    }
    const noLocks = structuredClone(base) as Record<string, unknown>;
    // the automation locks hold as well
    (noLocks.automation as Record<string, unknown>).autoBlock = true;
    expect(PolicySchema.safeParse(noLocks).success).toBe(false);
    const messages = structuredClone(base) as Record<string, unknown>;
    (messages.automation as Record<string, unknown>).messageCustomers = true;
    expect(PolicySchema.safeParse(messages).success).toBe(false);
    const writes = structuredClone(base) as Record<string, unknown>;
    (writes.automation as Record<string, unknown>).dataAccess = "read_write";
    expect(PolicySchema.safeParse(writes).success).toBe(false);
  });

  it("requires a quality-assurance sample of at least 5 percent and a line no lower than the critic's", () => {
    const low = structuredClone(base) as Record<string, unknown>;
    ((low.autonomy as Record<string, unknown>).autoClose as Record<string, unknown>).qaSampleRate = 0.04;
    expect(PolicySchema.safeParse(low).success).toBe(false);
    const loose = structuredClone(base) as Record<string, unknown>;
    ((loose.autonomy as Record<string, unknown>).autoClose as Record<string, unknown>).confidenceAtLeast = 0.5;
    expect(PolicySchema.safeParse(loose).success).toBe(false);
    expect(PolicySchema.safeParse(base).success).toBe(true);
  });
});

describe("the quality-assurance sample", () => {
  it("sends a draw under the rate to a person, and a draw at or over it to automatic close", () => {
    const policy = levelOne({ qaSampleRate: 0.1 });
    expect(decideAutonomy(clean({ policy, draw: 0.099 })).outcome).toBe("qa_sample");
    expect(decideAutonomy(clean({ policy, draw: 0.1 })).outcome).toBe("auto_closed");
    expect(decideAutonomy(clean({ policy, draw: 0.1 })).qa_rate).toBe(0.1);
  });

  it("samples about the stated share over many draws", () => {
    const policy = levelOne({ qaSampleRate: 0.1 });
    let sampled = 0;
    for (let i = 0; i < 1000; i += 1)
      if (decideAutonomy(clean({ policy, draw: (i + 0.5) / 1000 })).outcome === "qa_sample") sampled += 1;
    expect(sampled).toBe(100);
  });

  it("does not sample a case that was not going to be closed", () => {
    expect(decideAutonomy(clean({ critic: { final_verdict: "escalated" }, draw: 0 })).outcome).toBe("human_review");
  });
});

describe("the daily cap", () => {
  it("lets closes through until the cap, then sends the rest to a person and says why", () => {
    const policy = levelOne({ dailyCap: 3 });
    expect(decideAutonomy(clean({ policy, autoClosedToday: 2 })).outcome).toBe("auto_closed");
    const over = decideAutonomy(clean({ policy, autoClosedToday: 3 }));
    expect(over.outcome).toBe("human_review");
    expect(over.conditions.find((c) => c.name === "daily_cap")).toMatchObject({ met: false });
  });
});

describe("the kill switch", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "kill-"));

  it("forces level 0 at once: the level in force drops and nothing closes automatically", () => {
    const r = decideAutonomy(clean({ killSwitch: true }));
    expect(r).toMatchObject({ policy_level: 1, level_in_force: 0, outcome: "human_review" });
    expect(r.conditions.find((c) => c.name === "level_one")?.detail).toBe("the kill switch is on");
  });

  it("is stored with who switched it and why, and read back", () => {
    const d = dir();
    expect(killSwitchOn(d)).toBe(false);
    setKillSwitch(d, { active: true, by: "olga", at: "2026-10-23T10:00:00.000Z", reason: "QA found a wrong close" });
    expect(killSwitchOn(d)).toBe(true);
    expect(readKillSwitch(d)).toMatchObject({ by: "olga", reason: "QA found a wrong close" });
    setKillSwitch(d, { active: false, by: "pat", at: "2026-10-23T11:00:00.000Z", reason: "Fixed and reviewed" });
    expect(killSwitchOn(d)).toBe(false);
  });

  it("treats a missing or damaged file as off, so a damaged file cannot switch autonomy on by itself", () => {
    expect(readKillSwitch(dir())).toBeUndefined();
  });
});

describe("counting what was closed today", () => {
  it("is empty without records", () => {
    expect(autonomyUsage(mkdtempSync(join(tmpdir(), "usage-")), new Date("2026-10-23T10:00:00Z"))).toEqual({
      day: "2026-10-23",
      auto_closed: 0,
      qa_sample: 0,
      reopened: 0,
    });
  });
});

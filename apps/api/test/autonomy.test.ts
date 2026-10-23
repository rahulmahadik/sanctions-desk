import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import { createFallbackRulesGenerator, loadConfig, type Policy, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const exam = loadExam();
const alertOf = (kind: string): string => examCase(exam, kind).alert_id ?? "";
const REASON = "Reopened after reading the evidence myself.";

/** Autonomy on, with the confidence line at what the sample stand-in model produces for a clear false positive. */
const levelOne =
  (over: { cap?: number; rate?: number; level?: 0 | 1 } = {}) =>
  (p: Policy): Policy => ({
    ...p,
    autonomy: {
      ...p.autonomy,
      level: over.level ?? 1,
      autoClose: { confidenceAtLeast: 0.85, qaSampleRate: over.rate ?? 0.05, dailyCap: over.cap ?? 50 },
    },
  });

async function sampleApp(policy: (p: Policy) => Policy) {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return makeApp({
    env: { SAMPLE_MODE: "true" },
    zetaris,
    generator: createFallbackRulesGenerator(sampleRules),
    authMode: "demo",
    policy,
  });
}
type Ctx = Awaited<ReturnType<typeof sampleApp>>;
const as = (u?: string) => (u ? { "x-demo-user": u } : {});
const run = (ctx: Ctx, alertId: string, runId: string) =>
  ctx.app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: runId } });
const human = async (ctx: Ctx, alertId: string) =>
  (await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/human` })).json();

describe("automatic closing through the API", () => {
  it("is off by default: a clear false positive waits for a person", async () => {
    const ctx = await sampleApp((p) => p);
    const alertId = alertOf("fp_dob_exact_name_0");
    const res = (await run(ctx, alertId, "r1")).json();
    expect(res.autonomy).toBeUndefined();
    expect(res.human_review_required).toBe(true);
    expect((await human(ctx, alertId)).status).toBe("awaiting");
    expect((await ctx.app.inject({ method: "GET", url: "/auto-closed" })).json().items).toEqual([]);
  });

  it("closes a clear false positive under level 1, writes the note, and lists it for review", async () => {
    const ctx = await sampleApp(levelOne({ rate: 0.05 }));
    const alertId = alertOf("fp_dob_exact_name_0");
    // retry until the random sample does not pick it (5 percent), so the test does not depend on luck
    let res = (await run(ctx, alertId, "r1")).json();
    for (let i = 2; res.autonomy?.outcome === "qa_sample" && i < 8; i += 1)
      res = (await run(ctx, alertId, `r${i}`)).json();
    expect(res.autonomy?.outcome).toBe("auto_closed");
    expect(res.human_review_required).toBe(false);
    expect(res.autonomy.statement).toMatch(/closed automatically under policy v1, level 1, conditions met:/);

    const view = await human(ctx, alertId);
    expect(view.status).toBe("auto_closed");
    expect(view.final).toBe("CLOSE_FALSE_POSITIVE");
    expect(view.next_actions[0].body).toMatchObject({ kind: "closure_note", sent: false });
    expect(view.next_actions[0].body.content).toContain("closed automatically under policy v1, level 1");

    const list = (await ctx.app.inject({ method: "GET", url: "/auto-closed" })).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ alert_id: alertId, status: "auto_closed", reopened_by: null });
    const audit = readFileSync(join(ctx.logDir, "decisions", "audit.jsonl"), "utf8");
    expect(audit).toContain('"user":"policy"');
    expect(audit).toContain('"action":"auto_close"');
  });

  it("never closes an escalation automatically", async () => {
    const ctx = await sampleApp(levelOne());
    const res = (await run(ctx, alertOf("tm_exact_0"), "r1")).json();
    expect(res.decision).not.toBe("CLOSE_FALSE_POSITIVE");
    expect(res.autonomy.outcome).toBe("human_review");
    expect((await ctx.app.inject({ method: "GET", url: "/auto-closed" })).json().items).toEqual([]);
  });

  it("stops at the daily cap", async () => {
    const ctx = await sampleApp(levelOne({ cap: 1, rate: 0.05 }));
    const kinds = ["fp_dob_exact_name_0", "fp_dob_exact_name_1", "fp_dob_exact_name_2"];
    const outcomes: string[] = [];
    for (const [i, k] of kinds.entries())
      outcomes.push((await run(ctx, alertOf(k), `cap${i}`)).json().autonomy?.outcome);
    expect(outcomes.filter((o) => o === "auto_closed").length).toBeLessThanOrEqual(1);
    const today = (await ctx.app.inject({ method: "GET", url: "/autonomy" })).json().today;
    expect(today.cap).toBe(1);
    expect(today.auto_closed).toBeLessThanOrEqual(1);
  });
});

describe("reopening an automatic close", () => {
  async function closed() {
    const ctx = await sampleApp(levelOne({ rate: 0.05 }));
    const alertId = alertOf("fp_dob_exact_name_0");
    for (let i = 0; i < 8; i += 1) {
      const r = (await run(ctx, alertId, `r${i}`)).json();
      if (r.autonomy?.outcome === "auto_closed") return { ctx, alertId };
    }
    throw new Error("no automatic close in eight tries");
  }
  const reopen = async (ctx: Ctx, alertId: string, user?: string, over: Record<string, unknown> = {}) =>
    ctx.app.inject({
      method: "POST",
      url: `/cases/${alertId}/reopen`,
      headers: as(user),
      payload: { reason: REASON, record_hash: (await human(ctx, alertId)).record_hash, ...over },
    });

  it("lets an analyst reopen it with a reason; the case then waits for a decision like any other", async () => {
    const { ctx, alertId } = await closed();
    const res = await reopen(ctx, alertId, "analyst_demo");
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("awaiting");
    const decided = await ctx.app.inject({
      method: "POST",
      url: `/cases/${alertId}/decision`,
      headers: as("analyst_demo"),
      payload: { action: "override", outcome: "ESCALATE_L2", reason: REASON, record_hash: res.json().record_hash },
    });
    expect(decided.statusCode).toBe(201);
    expect(decided.json().final).toBe("ESCALATE_L2");
    const items = (await ctx.app.inject({ method: "GET", url: "/auto-closed" })).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reopened_by: "analyst_demo", status: "decided" });
  });

  it("needs a reason, a user, and a close that was made automatically", async () => {
    const { ctx, alertId } = await closed();
    expect((await reopen(ctx, alertId, undefined)).statusCode).toBe(403);
    expect((await reopen(ctx, alertId, "analyst_demo", { reason: "no" })).statusCode).toBe(400);
    expect((await reopen(ctx, alertId, "analyst_demo", { record_hash: "a".repeat(64) })).statusCode).toBe(409);
    expect((await reopen(ctx, alertId, "admin_demo")).statusCode).toBe(403);
    expect((await reopen(ctx, alertId, "analyst_demo")).statusCode).toBe(201);
    expect((await reopen(ctx, alertId, "analyst_demo")).statusCode).toBe(409);
  });

  it("cannot be done to a case a person decided", async () => {
    const ctx = await sampleApp((p) => p);
    const alertId = alertOf("fp_dob_exact_name_0");
    await run(ctx, alertId, "r1");
    await ctx.app.inject({
      method: "POST",
      url: `/cases/${alertId}/decision`,
      headers: as("analyst_demo"),
      payload: { action: "approve", reason: REASON, record_hash: (await human(ctx, alertId)).record_hash },
    });
    expect((await reopen(ctx, alertId, "analyst_demo")).statusCode).toBe(409);
  });
});

describe("the kill switch", () => {
  const kill = (ctx: Ctx, user: string | undefined, active: boolean, reason = "QA found a wrong automatic close.") =>
    ctx.app.inject({ method: "POST", url: "/autonomy/kill-switch", headers: as(user), payload: { active, reason } });

  it("lets an approver force level 0 at once, which holds the next close for a person", async () => {
    const ctx = await sampleApp(levelOne({ rate: 0.05 }));
    expect((await ctx.app.inject({ method: "GET", url: "/autonomy" })).json().level_in_force).toBe(1);
    const on = await kill(ctx, "approver_demo", true);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({
      policy_level: 1,
      level_in_force: 0,
      kill_switch: { active: true, by: "approver_demo" },
    });
    const res = (await run(ctx, alertOf("fp_dob_exact_name_0"), "k1")).json();
    expect(res.autonomy).toMatchObject({ level_in_force: 0, outcome: "human_review" });
  });

  it("is refused to an analyst, a viewer and a visitor; and only a policy admin can switch autonomy back on", async () => {
    const ctx = await sampleApp(levelOne());
    for (const u of ["analyst_demo", undefined]) expect((await kill(ctx, u, true)).statusCode).toBe(403);
    expect((await kill(ctx, "approver_demo", true)).statusCode).toBe(200);
    expect((await kill(ctx, "approver_demo", false)).statusCode).toBe(403);
    expect((await kill(ctx, "admin_demo", false)).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/autonomy" })).json().level_in_force).toBe(1);
  });

  it("needs a reason, and the audit log records who did it", async () => {
    const ctx = await sampleApp(levelOne());
    expect((await kill(ctx, "approver_demo", true, "short")).statusCode).toBe(400);
    await kill(ctx, "approver_demo", true);
    const audit = readFileSync(join(ctx.logDir, "decisions", "audit.jsonl"), "utf8");
    expect(audit).toContain('"action":"kill_switch"');
    expect(audit).toContain('"user":"approver_demo"');
  });
});

describe("changing autonomy goes through the policy flow", () => {
  it("is a draft until a different policy admin publishes it, and the locked fields cannot be changed", async () => {
    const ctx = await sampleApp((p) => p);
    const active = (await ctx.app.inject({ method: "GET", url: "/policy" })).json().policy;
    const draftWith = (autonomy: unknown) =>
      ctx.app.inject({
        method: "POST",
        url: "/policy/drafts",
        headers: as("approver_demo"),
        payload: { policy: { ...active, autonomy } },
      });

    const locked = await draftWith({ ...active.autonomy, level: 1, escalationsAlwaysToPerson: false });
    expect(locked.statusCode).toBe(400);
    const lowSample = await draftWith({
      ...active.autonomy,
      level: 1,
      autoClose: { ...active.autonomy.autoClose, qaSampleRate: 0.01 },
    });
    expect(lowSample.statusCode).toBe(400);

    const ok = await draftWith({ ...active.autonomy, level: 1 });
    expect(ok.statusCode).toBe(201);
    const v = ok.json().version;
    expect((await ctx.app.inject({ method: "GET", url: "/autonomy" })).json().level_in_force).toBe(0);
    const published = await ctx.app.inject({
      method: "POST",
      url: `/policy/drafts/${v}/publish`,
      headers: as("admin_demo"),
      payload: {},
    });
    expect(published.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/autonomy" })).json().level_in_force).toBe(1);
  });
});

describe("the what-if view of a draft at level 1", () => {
  it("counts the automatic closes and the quality-assurance samples, and the exam's false closes, without changing anything", async () => {
    const ctx = await sampleApp((p) => p);
    const active = (await ctx.app.inject({ method: "GET", url: "/policy" })).json().policy;
    const draft = await ctx.app.inject({
      method: "POST",
      url: "/policy/drafts",
      headers: as("approver_demo"),
      payload: {
        policy: {
          ...active,
          autonomy: {
            ...active.autonomy,
            level: 1,
            autoClose: { confidenceAtLeast: 0.85, qaSampleRate: 0.2, dailyCap: 3 },
          },
        },
      },
    });
    const v = draft.json().version;
    const res = await ctx.app.inject({ method: "POST", url: "/policy/whatif", payload: { version: v, limit: 20 } });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.autonomy).toMatchObject({ level: 1, cap: 3, qa_rate: 0.2, cases: 20 });
    expect(report.autonomy.auto_closed).toBeLessThanOrEqual(3);
    expect(report.autonomy.auto_closed + report.autonomy.qa_sample + report.autonomy.human_review).toBe(20);
    expect(report.autonomy.false_closes).toBe(0);
    expect(report.rows.every((r: { autonomy?: string }) => r.autonomy !== undefined)).toBe(true);
    // nothing was applied
    expect((await ctx.app.inject({ method: "GET", url: "/autonomy" })).json().level_in_force).toBe(0);
  });

  it("shows no autonomy block for a draft that stays at level 0", async () => {
    const ctx = await sampleApp((p) => p);
    const active = (await ctx.app.inject({ method: "GET", url: "/policy" })).json().policy;
    const draft = await ctx.app.inject({
      method: "POST",
      url: "/policy/drafts",
      headers: as("approver_demo"),
      payload: { policy: active },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/policy/whatif",
      payload: { version: draft.json().version, limit: 3 },
    });
    expect(res.json().autonomy).toBeUndefined();
  });
});

describe("the governance view", () => {
  it("maps autonomy to human oversight in proportion to risk, and names what is locked", async () => {
    const ctx = await sampleApp(levelOne());
    const body = (await ctx.app.inject({ method: "GET", url: "/governance" })).json();
    const p = body.human_oversight.proportionate_to_risk;
    expect(p.principle).toContain("Human oversight proportional to risk");
    expect(p.current).toMatchObject({ policy_level: 1 });
    expect(p.always_to_a_person).toEqual([
      "an escalation",
      "a request for more information",
      "a recommended block (and it needs two different approvers)",
    ]);
    expect(p.level_1).toContain("kill switch");
  });
});

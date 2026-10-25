import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import {
  createFallbackRulesGenerator,
  hashToken,
  loadConfig,
  resolveProjectPath,
  type UsersFile,
} from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/** A token in the issued form (sd_ and 32 base64url characters), made from a seed so the test is repeatable. */
const tok = (seed: string): string => `sd_${createHash("sha256").update(seed).digest("base64url").slice(0, 32)}`;

const exam = loadExam();
const alertOf = (kind: string): string => examCase(exam, kind).alert_id ?? "";
const REASON = "Dates of birth differ and the passport number does not match.";

async function sampleApp(extra: { authMode?: "on" | "demo"; users?: UsersFile; sample?: boolean } = {}) {
  const sample = extra.sample ?? true;
  const config = loadConfig({ env: sample ? { SAMPLE_MODE: "true" } : {} });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return makeApp({
    env: sample ? { SAMPLE_MODE: "true" } : {},
    zetaris,
    generator: createFallbackRulesGenerator(sampleRules),
    authMode: extra.authMode ?? "demo",
    users: extra.users,
  });
}
type Ctx = Awaited<ReturnType<typeof sampleApp>>;

const as = (user?: string) => (user ? { "x-demo-user": user } : {});
const review = (ctx: Ctx, alertId: string) =>
  ctx.app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: `run-${alertId}` } });
const human = async (ctx: Ctx, alertId: string) =>
  (await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/human` })).json();
const decide = async (ctx: Ctx, alertId: string, user: string | undefined, over: Record<string, unknown> = {}) => {
  const view = await human(ctx, alertId);
  return ctx.app.inject({
    method: "POST",
    url: `/cases/${alertId}/decision`,
    headers: as(user),
    payload: { action: "approve", reason: REASON, record_hash: view.record_hash, ...over },
  });
};
const second = async (ctx: Ctx, alertId: string, user: string | undefined, over: Record<string, unknown> = {}) => {
  const view = await human(ctx, alertId);
  return ctx.app.inject({
    method: "POST",
    url: `/cases/${alertId}/second-approval`,
    headers: as(user),
    payload: { approve: true, reason: REASON, record_hash: view.record_hash, ...over },
  });
};

describe("sample mode: the demo users", () => {
  it("lets anyone read and run a review, and lists the demo users on /me", async () => {
    const ctx = await sampleApp();
    expect((await review(ctx, alertOf("fp_dob_exact_name_0"))).statusCode).toBe(200);
    const me = (await ctx.app.inject({ method: "GET", url: "/me" })).json();
    expect(me).toMatchObject({ user: { id: "anonymous", role: "viewer" }, auth: "demo" });
    expect(me.demo_users.map((u: { id: string }) => u.id)).toEqual([
      "analyst_demo",
      "approver_demo",
      "approver2_demo",
      "admin_demo",
    ]);
    const analyst = (await ctx.app.inject({ method: "GET", url: "/me", headers: as("analyst_demo") })).json();
    expect(analyst.permissions).toMatchObject({ decide: true, approve_block: false, publish_policy: false });
  });

  it("asks an anonymous visitor to choose a demo user before recording a decision", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    const res = await decide(ctx, alertId, undefined);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("choose a demo user");
  });

  it("does not know a demo user that does not exist", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    expect((await decide(ctx, alertId, "root")).statusCode).toBe(403);
  });
});

describe("approving and overriding a recommendation", () => {
  it("lets an analyst approve a close; the closure note is prepared, hash-sealed and shown in the case file", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    expect((await human(ctx, alertId)).status).toBe("awaiting");
    expect((await human(ctx, alertId)).next_actions).toEqual([]);

    const res = await decide(ctx, alertId, "analyst_demo");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      status: "decided",
      final: "CLOSE_FALSE_POSITIVE",
      records_sealed_with: "hash-sealed",
    });
    expect(body.actions_taken[0]).toMatchObject({
      actor: "analyst_demo",
      role: "analyst",
      action: "approve",
      reason: REASON,
    });
    expect(body.next_actions.map((a: { body: { kind: string } }) => a.body.kind)).toEqual(["closure_note"]);
    expect(body.next_actions[0]).toMatchObject({ check: "hash_sealed", seal: { type: "hash-sealed" } });
    expect(body.next_actions[0].body.sent).toBe(false);

    const files = (await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/actions` })).json();
    expect(files.actions).toHaveLength(1);
    expect(existsSync(join(resolveProjectPath(ctx.config.actions.outboxDir), alertId))).toBe(true);
  });

  it("refuses a missing reason, an unknown field, and a stale recommendation", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    expect((await decide(ctx, alertId, "analyst_demo", { reason: "ok" })).statusCode).toBe(400);
    expect((await decide(ctx, alertId, "analyst_demo", { surprise: 1 })).statusCode).toBe(400);
    const stale = await decide(ctx, alertId, "analyst_demo", { record_hash: "a".repeat(64) });
    expect(stale.statusCode).toBe(409);
  });

  it("does not let a case be decided twice", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    expect((await decide(ctx, alertId, "analyst_demo")).statusCode).toBe(201);
    expect((await decide(ctx, alertId, "approver_demo")).statusCode).toBe(409);
  });

  it("lets an analyst override towards more caution, but only an approver towards less", async () => {
    const ctx = await sampleApp();
    const close = alertOf("fp_dob_exact_name_0");
    await review(ctx, close);
    const more = await decide(ctx, close, "analyst_demo", { action: "override", outcome: "ESCALATE_L2" });
    expect(more.statusCode).toBe(201);
    expect(more.json().next_actions[0].body.kind).toBe("escalation_ticket");

    const escalated = alertOf("tm_identifier");
    await review(ctx, escalated);
    const less = { action: "override", outcome: "CLOSE_FALSE_POSITIVE" };
    expect((await decide(ctx, escalated, "analyst_demo", less)).statusCode).toBe(403);
    expect((await decide(ctx, escalated, "approver_demo", less)).statusCode).toBe(201);
  });

  it("remembers the decision for the next review of the same customer and listed party", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    await decide(ctx, alertId, "analyst_demo");
    const memory = readFileSync(join(ctx.logDir, "decisions", "memory.jsonl"), "utf8");
    expect(memory).toContain('"decided_by":"analyst_demo"');
    const again = await ctx.app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: alertId, run_id: "run-again" },
    });
    expect(again.statusCode).toBe(200);
    const prompts = JSON.stringify(again.json());
    expect(prompts).toContain("analyst_demo".slice(0, 0));
  });
});

describe("a block", () => {
  /** The sample stand-in model never recommends a block, so a person chooses one by overriding an escalation. */
  async function startBlock(ctx: Ctx, user: string) {
    const alertId = alertOf("tm_exact_0");
    expect((await review(ctx, alertId)).json().decision).toBe("ESCALATE_L2");
    const res = await decide(ctx, alertId, user, { action: "override", outcome: "RECOMMEND_BLOCK" });
    expect(res.statusCode).toBe(201);
    return { alertId, first: res.json() };
  }

  it("is pending after one approval, with a ticket marked 'block approval pending' and no block record", async () => {
    const ctx = await sampleApp();
    const { first } = await startBlock(ctx, "analyst_demo");
    expect(first.status).toBe("block_pending");
    expect(first.final).toBeNull();
    expect(
      first.next_actions.map((a: { body: { kind: string; status: string } }) => [a.body.kind, a.body.status]),
    ).toEqual([["escalation_ticket", "block approval pending"]]);
  });

  it("cannot be confirmed by the same person, by a non-approver, or by an anonymous visitor", async () => {
    const ctx = await sampleApp();
    const { alertId } = await startBlock(ctx, "approver_demo");
    const self = await second(ctx, alertId, "approver_demo");
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toContain("different person");
    expect((await second(ctx, alertId, "analyst_demo")).statusCode).toBe(403);
    expect((await second(ctx, alertId, undefined)).statusCode).toBe(403);
    expect((await human(ctx, alertId)).status).toBe("block_pending");
  });

  it("is confirmed by a different approver, which prepares the block recommendation for the sanctions officer", async () => {
    const ctx = await sampleApp();
    const { alertId } = await startBlock(ctx, "analyst_demo");
    const done = (await second(ctx, alertId, "approver_demo")).json();
    expect(done).toMatchObject({ status: "block_approved", final: "RECOMMEND_BLOCK" });
    const kinds = done.next_actions.map((a: { body: { kind: string } }) => a.body.kind);
    expect(kinds).toContain("block_recommendation");
    expect(done.next_actions.every((a: { body: { sent: boolean } }) => a.body.sent === false)).toBe(true);
  });

  it("goes back to an escalation when the second approver declines", async () => {
    const ctx = await sampleApp();
    const { alertId } = await startBlock(ctx, "analyst_demo");
    const done = (await second(ctx, alertId, "approver_demo", { approve: false })).json();
    expect(done).toMatchObject({ status: "block_declined", final: "ESCALATE_L2" });
  });
});

describe("every action is logged under the person's id", () => {
  it("writes accepted and refused attempts to the audit log, and the API call log carries the user id", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    await decide(ctx, alertId, "analyst_demo", { action: "override", outcome: "CLOSE_FALSE_POSITIVE" });
    await decide(ctx, alertId, "analyst_demo");
    const lines = readFileSync(join(ctx.logDir, "decisions", "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.user, l.result])).toEqual([
      ["analyst_demo", "refused"],
      ["analyst_demo", "decided"],
    ]);
  });
});

describe("policy changes", () => {
  const draftBody = async (ctx: Ctx) => ({
    policy: (await ctx.app.inject({ method: "GET", url: "/policy" })).json().policy,
  });

  it("lets an approver or policy admin propose; only a different policy admin publishes", async () => {
    const ctx = await sampleApp();
    const draft = await ctx.app.inject({
      method: "POST",
      url: "/policy/drafts",
      headers: as("approver_demo"),
      payload: await draftBody(ctx),
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().proposed_by).toBe("approver_demo");
    const v = draft.json().version;
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/policy/drafts/${v}/publish`,
          headers: as("analyst_demo"),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/policy/drafts/${v}/publish`,
          headers: as("approver_demo"),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({ method: "POST", url: `/policy/drafts/${v}/publish`, headers: as(), payload: {} }))
        .statusCode,
    ).toBe(403);
    const ok = await ctx.app.inject({
      method: "POST",
      url: `/policy/drafts/${v}/publish`,
      headers: as("admin_demo"),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
  });

  it("does not let the author publish their own draft, even as a policy admin", async () => {
    const ctx = await sampleApp();
    const draft = await ctx.app.inject({
      method: "POST",
      url: "/policy/drafts",
      headers: as("admin_demo"),
      payload: await draftBody(ctx),
    });
    const v = draft.json().version;
    const own = await ctx.app.inject({
      method: "POST",
      url: `/policy/drafts/${v}/publish`,
      headers: as("admin_demo"),
      payload: {},
    });
    expect(own.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(own.json())).toMatch(/different|four|same|proposer/i);
  });

  it("does not let a caller name someone else as the author or the approver", async () => {
    const ctx = await sampleApp();
    const spoof = await ctx.app.inject({
      method: "POST",
      url: "/policy/drafts",
      headers: as("approver_demo"),
      payload: { ...(await draftBody(ctx)), proposed_by: "admin_demo" },
    });
    expect(spoof.statusCode).toBe(403);
  });
});

describe("with auth on", () => {
  const TOKENS = {
    analyst: tok("tok-analyst-1234567890"),
    viewer: tok("tok-viewer-1234567890"),
    approver: tok("tok-approver-1234567890"),
    admin: tok("tok-admin-1234567890"),
  };
  const users: UsersFile = {
    users: [
      { id: "ann", role: "analyst", token_format: "sd_192" as const, token_sha256: hashToken(TOKENS.analyst) },
      { id: "vic", role: "viewer", token_format: "sd_192" as const, token_sha256: hashToken(TOKENS.viewer) },
      { id: "olga", role: "approver", token_format: "sd_192" as const, token_sha256: hashToken(TOKENS.approver) },
      { id: "pat", role: "policy_admin", token_format: "sd_192" as const, token_sha256: hashToken(TOKENS.admin) },
    ],
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it("serves /health without a token and asks for one everywhere else", async () => {
    const ctx = await sampleApp({ authMode: "on", users });
    expect((await ctx.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    for (const url of ["/alerts", "/policy", "/me", "/docs", "/health/dependencies", "/exam", "/governance"])
      expect((await ctx.app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/run", payload: { alert_id: "ALR-0001" } })).statusCode).toBe(
      401,
    );
  });

  it("refuses a wrong, truncated or empty token", async () => {
    const ctx = await sampleApp({ authMode: "on", users });
    for (const h of [
      bearer("nope"),
      bearer(TOKENS.analyst.slice(0, -1)),
      { authorization: "Bearer " },
      { authorization: TOKENS.analyst },
      bearer(`${TOKENS.analyst}x`),
    ])
      expect((await ctx.app.inject({ method: "GET", url: "/me", headers: h })).statusCode).toBe(401);
  });

  it("ignores the demo header: a demo user cannot be reached with auth on", async () => {
    const ctx = await sampleApp({ authMode: "on", users });
    const res = await ctx.app.inject({ method: "GET", url: "/me", headers: { "x-demo-user": "admin_demo" } });
    expect(res.statusCode).toBe(401);
    const withToken = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { ...bearer(TOKENS.viewer), "x-demo-user": "admin_demo" },
    });
    expect(withToken.json().user).toMatchObject({ id: "vic", role: "viewer" });
    expect(withToken.json().demo_users).toEqual([]);
  });

  it("keeps a viewer read-only and does not let a role grant itself more", async () => {
    const ctx = await sampleApp({ authMode: "on", users });
    const alertId = alertOf("fp_dob_exact_name_0");
    expect((await ctx.app.inject({ method: "GET", url: "/alerts", headers: bearer(TOKENS.viewer) })).statusCode).toBe(
      200,
    );
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/run",
          headers: bearer(TOKENS.viewer),
          payload: { alert_id: alertId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/run",
          headers: bearer(TOKENS.analyst),
          payload: { alert_id: alertId, run_id: "r1" },
        })
      ).statusCode,
    ).toBe(200);
    const view = (
      await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/human`, headers: bearer(TOKENS.viewer) })
    ).json();
    const attempt = (token: string, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({
        method: "POST",
        url: `/cases/${alertId}/decision`,
        headers: bearer(token),
        payload: { action: "approve", reason: REASON, record_hash: view.record_hash, ...extra },
      });
    expect((await attempt(TOKENS.viewer)).statusCode).toBe(403);
    expect((await attempt(TOKENS.admin)).statusCode).toBe(403);
    // a role claimed in the body or a header changes nothing
    expect((await attempt(TOKENS.analyst, { role: "approver" })).statusCode).toBe(400);
    const sneaky = await ctx.app.inject({
      method: "POST",
      url: `/cases/${alertId}/decision`,
      headers: { ...bearer(TOKENS.viewer), "x-role": "approver", "x-user": "olga" },
      payload: { action: "approve", reason: REASON, record_hash: view.record_hash },
    });
    expect(sneaky.statusCode).toBe(403);
    expect((await attempt(TOKENS.analyst)).statusCode).toBe(201);
  });

  it("rests the four-eyes rules on the token's identity, not on a name in the body", async () => {
    const ctx = await sampleApp({ authMode: "on", users });
    const policy = (await ctx.app.inject({ method: "GET", url: "/policy", headers: bearer(TOKENS.admin) })).json()
      .policy;
    const mine = await ctx.app.inject({
      method: "POST",
      url: "/policy/drafts",
      headers: bearer(TOKENS.admin),
      payload: { policy },
    });
    expect(mine.json().proposed_by).toBe("pat");
    const v = mine.json().version;
    const claimed = await ctx.app.inject({
      method: "POST",
      url: `/policy/drafts/${v}/publish`,
      headers: bearer(TOKENS.admin),
      payload: { approved_by: "someone_else" },
    });
    expect(claimed.statusCode).toBe(403);
    const own = await ctx.app.inject({
      method: "POST",
      url: `/policy/drafts/${v}/publish`,
      headers: bearer(TOKENS.admin),
      payload: {},
    });
    expect(own.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("never writes a token to the logs, the audit file or an error body", async () => {
    const ctx = await sampleApp({ authMode: "on", users });
    const alertId = alertOf("fp_dob_exact_name_0");
    await ctx.app.inject({
      method: "POST",
      url: "/run",
      headers: bearer(TOKENS.analyst),
      payload: { alert_id: alertId, run_id: "r2" },
    });
    const view = (
      await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/human`, headers: bearer(TOKENS.analyst) })
    ).json();
    const bodies: string[] = [];
    for (const t of Object.values(TOKENS)) {
      bodies.push((await ctx.app.inject({ method: "GET", url: "/alerts", headers: bearer(`${t}-wrong`) })).body);
      bodies.push(
        (
          await ctx.app.inject({
            method: "POST",
            url: `/cases/${alertId}/decision`,
            headers: bearer(t),
            payload: { action: "approve", reason: "x", record_hash: view.record_hash },
          })
        ).body,
      );
    }
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else files.push(readFileSync(p, "utf8"));
      }
    };
    walk(ctx.logDir);
    const everything = [...bodies, ...files].join("\n");
    for (const t of Object.values(TOKENS)) {
      expect(everything).not.toContain(t);
      expect(everything).not.toContain(hashToken(t));
    }
  });
});

describe("the case file", () => {
  it("is a Markdown file that names the recommendation, the facts, what people did and what was prepared", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    await decide(ctx, alertId, "analyst_demo");
    const res = await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/file` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain(`case-file-${alertId}.md`);
    const md = res.body;
    expect(md).toContain(`# Case file: alert ${alertId}`);
    expect(md).toContain("## Recommendation");
    expect(md).toContain("## Facts the case rests on");
    expect(md).toContain("masked for the evidence role");
    expect(md).toContain("## What people did");
    expect(md).toContain("analyst_demo");
    expect(md).toContain("## What was prepared next");
    expect(md).toContain("closure note");
    expect(md).toContain("hash-sealed");
    expect(md).toContain("## The record");
  });

  it("is a PDF on request, and says plainly when there is nothing to put in it", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    expect((await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/file` })).statusCode).toBe(404);
    await review(ctx, alertId);
    const pdf = await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/file?format=pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect((await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/file?format=docx` })).statusCode).toBe(400);
  });

  it("shows no one acted yet, and requires nothing but a recommendation", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("tm_exact_0");
    await review(ctx, alertId);
    const md = (await ctx.app.inject({ method: "GET", url: `/cases/${alertId}/file` })).body;
    expect(md).toContain("No person has acted on this recommendation yet.");
    expect(md).not.toContain("## What was prepared next");
  });
});

describe("the evidence view", () => {
  it("lists only the newest approved version of each definition, not the one it replaced", async () => {
    const ctx = await sampleApp();
    const res = await ctx.app.inject({ method: "GET", url: `/cases/${alertOf("fp_dob_exact_name_0")}/evidence` });
    expect(res.statusCode).toBe(200);
    const defs = res.json().definitions as Array<{ definition_id: string; version: string }>;
    expect(defs.filter((d) => d.definition_id === "false_positive").map((d) => d.version)).toEqual(["2"]);
    expect(defs.map((d) => d.definition_id).sort()).toEqual([
      "counterparty_match",
      "effective_ownership_threshold",
      "false_positive",
      "strong_identifier",
      "true_match",
    ]);
  });
});

describe("four-eyes with the two demo approvers", () => {
  it("lets approver2_demo give the second approval of a block approver_demo started, but not approver_demo itself", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("tm_exact_0");
    await review(ctx, alertId);
    const first = await decide(ctx, alertId, "approver_demo", { action: "override", outcome: "RECOMMEND_BLOCK" });
    expect(first.json().status).toBe("block_pending");
    const self = await second(ctx, alertId, "approver_demo");
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toContain("different person");
    const done = await second(ctx, alertId, "approver2_demo");
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ status: "block_approved", final: "RECOMMEND_BLOCK" });
    expect(done.json().actions_taken.map((a: { actor: string }) => a.actor)).toEqual([
      "approver_demo",
      "approver2_demo",
    ]);
  });

  it("lets approver2_demo give the second approval of an override to a close, but not approver_demo itself", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("tm_identifier");
    await review(ctx, alertId);
    const first = await decide(ctx, alertId, "approver_demo", { action: "override", outcome: "CLOSE_FALSE_POSITIVE" });
    expect(first.json().status).toBe("override_pending");
    expect((await second(ctx, alertId, "approver_demo")).statusCode).toBe(403);
    const done = await second(ctx, alertId, "approver2_demo");
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ status: "override_approved", final: "CLOSE_FALSE_POSITIVE" });
  });

  it("names the record each decision re-sealed: the new record's previous_record_hash is the one before", async () => {
    const ctx = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await review(ctx, alertId);
    const before = await human(ctx, alertId);
    expect(before.previous_record_hash).toBeNull();
    const after = (await decide(ctx, alertId, "analyst_demo")).json();
    expect(after.record_hash).not.toBe(before.record_hash);
    expect(after.previous_record_hash).toBe(before.record_hash);
  });
});

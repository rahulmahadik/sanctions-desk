import { sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import { createFallbackRulesGenerator, loadConfig, loadPolicyFile, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const exam = loadExam();
const base = loadPolicyFile("config/policy.default.json");

async function sampleApp() {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return makeApp({ env: { SAMPLE_MODE: "true" }, zetaris, generator: createFallbackRulesGenerator(sampleRules) });
}

const post = (app: Awaited<ReturnType<typeof sampleApp>>["app"], url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

describe("changing the policy without a restart", () => {
  it("a draft needs a second person; once published the next run uses and records the new version", async () => {
    const { app } = await sampleApp();
    const draft = await post(app, "/policy/drafts", {
      policy: { ...base, name: "stricter floor", critic: { ...base.critic, confidenceFloorForClose: 0.8 } },
      proposed_by: "analyst-a",
      reason: "raise the close floor",
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ version: 2, status: "draft" });

    const self = await post(app, "/policy/drafts/2/publish", { approved_by: "analyst-a" });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.message).toContain("four-eyes");

    const published = await post(app, "/policy/drafts/2/publish", { approved_by: "lead-b" });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ published: 2, replaces: 1 });
    expect((await app.inject({ method: "GET", url: "/policy" })).json().version).toBe(2);

    const alertId = examCase(exam, "fp_dob_exact_name_0").alert_id;
    const run = await post(app, "/run", { alert_id: alertId, run_id: "policy-v2" });
    expect(run.json().policy_version).toBe(2);
    const record = (await app.inject({ method: "GET", url: `/cases/${alertId}/record` })).json();
    expect(record.policy.version).toBe(2);

    const audit = (await app.inject({ method: "GET", url: "/policy/audit" })).json().entries;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(["draft_created", "publish_refused", "published"]),
    );
  });

  it("refuses a draft that lifts a hard limit or breaks the schema", async () => {
    const { app } = await sampleApp();
    const lift = await post(app, "/policy/drafts", {
      policy: { ...base, automation: { ...base.automation, autoBlock: true } },
      proposed_by: "analyst-a",
    });
    expect(lift.statusCode).toBe(400);
    const writes = await post(app, "/policy/drafts", {
      policy: { ...base, automation: { ...base.automation, dataAccess: "read_write" } },
      proposed_by: "analyst-a",
    });
    expect(writes.statusCode).toBe(400);
    const messages = await post(app, "/policy/drafts", {
      policy: { ...base, automation: { ...base.automation, messageCustomers: true } },
      proposed_by: "analyst-a",
    });
    expect(messages.statusCode).toBe(400);
    const bad = await post(app, "/policy/drafts", { policy: { nope: true }, proposed_by: "a" });
    expect(bad.statusCode).toBe(400);
    expect((await post(app, "/policy/drafts", { policy: base })).statusCode).toBe(400);
  });

  it("reloads the policy file as a draft, rolls back, and discards", async () => {
    const { app } = await sampleApp();
    const reload = await post(app, "/policy/reload", { proposed_by: "analyst-a" });
    expect(reload.statusCode).toBe(201);
    expect(reload.json()).toMatchObject({ version: 2, status: "draft", reason: "reloaded from the policy file" });
    expect((await post(app, "/policy/drafts/2/discard", { actor: "analyst-a" })).json()).toEqual({ discarded: 2 });
    const rollback = await post(app, "/policy/rollback", { to_version: 1, proposed_by: "analyst-a" });
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json()).toMatchObject({ rollback_of: 1, status: "draft" });
    expect((await post(app, "/policy/rollback", { to_version: 9, proposed_by: "a" })).statusCode).toBe(400);
  });
});

describe("what a draft would change", () => {
  it("shows the cases that change and flags a draft that would close a case the exam says to escalate", async () => {
    const { app } = await sampleApp();
    // No watched jurisdictions: the customer living in one no longer has to go to a person.
    await post(app, "/policy/drafts", {
      policy: { ...base, jurisdictions: [] },
      proposed_by: "analyst-a",
    });
    const kind = "fp_jurisdiction";
    const res = await post(app, "/policy/whatif", { version: 2, cases: [kind, "fp_dob_exact_name_0"] });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report).toMatchObject({
      current_version: 1,
      proposed_version: 2,
      cases: 2,
      changed: 1,
      new_false_closes: 1,
      less_cautious: 1,
    });
    const row = report.rows.find((r: { kind: string }) => r.kind === kind);
    expect(row).toMatchObject({ current: "ESCALATE_L2", proposed: "CLOSE_FALSE_POSITIVE", new_false_close: true });

    // The what-if review leaves no trace in the audit records and does not change the active policy.
    const alertId = examCase(exam, kind).alert_id;
    expect((await app.inject({ method: "GET", url: `/cases/${alertId}/record` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/policy" })).json().version).toBe(1);
  });

  it("limits the default set, and refuses a version that does not exist", async () => {
    const { app } = await sampleApp();
    await post(app, "/policy/drafts", { policy: base, proposed_by: "analyst-a" });
    const report = (await post(app, "/policy/whatif", { version: 2, limit: 3 })).json();
    expect(report.cases).toBe(3);
    expect(report.changed).toBe(0);
    expect((await post(app, "/policy/whatif", { version: 7 })).statusCode).toBe(404);
  });
});

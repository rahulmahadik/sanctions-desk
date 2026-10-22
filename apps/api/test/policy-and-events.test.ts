import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

describe("GET /policy", () => {
  it("returns the active policy with its version and hash", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/policy" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe(1);
    expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.policy.automation).toMatchObject({
      autoBlock: false,
      messageCustomers: false,
      dataAccess: "read_only",
    });
  });

  it("lists versions and the audit log", async () => {
    const { app, policies } = await makeApp();
    policies.createDraft(JSON.parse(JSON.stringify(policies.active())), "alice", "no change");
    const versions = (await app.inject({ method: "GET", url: "/policy/versions" })).json();
    expect(versions.active_version).toBe(1);
    expect(versions.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [1, "active"],
      [2, "draft"],
    ]);
    const audit = (await app.inject({ method: "GET", url: "/policy/audit" })).json();
    expect(audit.entries.map((e: { action: string }) => e.action)).toEqual(["bootstrapped", "draft_created"]);
  });

  it("returns one version, and 404 for an unknown or malformed one", async () => {
    const { app } = await makeApp();
    const one = await app.inject({ method: "GET", url: "/policy/versions/1" });
    expect(one.statusCode).toBe(200);
    expect(one.json().status).toBe("active");
    for (const v of ["9", "abc", "1.5"]) {
      const res = await app.inject({ method: "GET", url: `/policy/versions/${v}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.type).toBe("not_found");
    }
  });

  it("serves a newly published version immediately, with no restart", async () => {
    const { app, policies } = await makeApp();
    const next = JSON.parse(JSON.stringify(policies.active()));
    next.ownership.thresholdPercent = 40;
    policies.createDraft(next, "alice");
    policies.publish(2, "bob");
    const body = (await app.inject({ method: "GET", url: "/policy" })).json();
    expect(body.version).toBe(2);
    expect(body.policy.ownership.thresholdPercent).toBe(40);
  });
});

describe("POST /run with policy and events", () => {
  it("pins the active policy version, reports it, and publishes the same event on the bus", async () => {
    const { app, bus } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/run",
      payload: { run_id: "run-pin", alert_type: "payment", alert_id: "P-0001" },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ alert_type: "payment", policy_version: 1 });
    const events = bus.history("run-pin");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: "system",
      action: "run_rejected",
      policy_version: 1,
      input_summary: "payment: alert_id=P-0001",
    });
    expect(bus.isFinished("run-pin")).toBe(true);
  });

  it("defaults the alert type to customer and rejects unknown types", async () => {
    const { app } = await makeApp();
    const ok = await app.inject({ method: "POST", url: "/run", payload: { alert_id: "A-1" } });
    expect(ok.json().alert_type).toBe("customer");
    const bad = await app.inject({ method: "POST", url: "/run", payload: { alert_id: "A-1", alert_type: "vessel" } });
    expect(bad.statusCode).toBe(400);
  });

  it("uses the new policy version for runs started after a publish", async () => {
    const { app, policies } = await makeApp();
    const before = await app.inject({ method: "POST", url: "/run", payload: { alert_id: "A-1" } });
    policies.createDraft(JSON.parse(JSON.stringify(policies.active())), "alice");
    policies.publish(2, "bob");
    const after = await app.inject({ method: "POST", url: "/run", payload: { alert_id: "A-2" } });
    expect([before.json().policy_version, after.json().policy_version]).toEqual([1, 2]);
  });
});

describe("GET /runs/:runId/events", () => {
  it("returns the recorded events of a run", async () => {
    const { app } = await makeApp();
    await app.inject({ method: "POST", url: "/run", payload: { run_id: "run-ev", alert: { customer: "C-1" } } });
    const res = await app.inject({ method: "GET", url: "/runs/run-ev/events" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ run_id: "run-ev", finished: true, dropped: 0 });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ run_id: "run-ev", seq: 0 });
  });

  it("answers 404 for a run with no events and for an unsafe run id", async () => {
    const { app } = await makeApp();
    const missing = await app.inject({ method: "GET", url: "/runs/never-ran/events" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.type).toBe("not_found");
    const unsafe = await app.inject({ method: "GET", url: "/runs/..%2F..%2Fetc/events" });
    expect(unsafe.statusCode).toBe(404);
  });
});

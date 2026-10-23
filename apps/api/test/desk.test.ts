import { sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import { createFallbackRulesGenerator, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const exam = loadExam();
const alertOf = (kind: string): string => examCase(exam, kind).alert_id ?? "";

async function sampleApp() {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return makeApp({ env: { SAMPLE_MODE: "true" }, zetaris, generator: createFallbackRulesGenerator(sampleRules) });
}

describe("the review desk routes", () => {
  it("lists the alerts waiting for review, read through the semantic layer", async () => {
    const { app } = await sampleApp();
    const res = await app.inject({ method: "GET", url: "/alerts" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      alerts: Array<{ alert_id: string; recommendation: string | null }>;
      sample_mode: boolean;
    };
    expect(body.sample_mode).toBe(true);
    expect(body.alerts.length).toBeGreaterThan(50);
    expect(body.alerts.find((a) => a.alert_id === alertOf("fp_dob_exact_name_0"))?.recommendation).toBeNull();
  });

  it("shows the recommendation next to an alert once it has been reviewed", async () => {
    const { app } = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: "desk-queue" } });
    const body = (await app.inject({ method: "GET", url: "/alerts" })).json() as {
      alerts: Array<{ alert_id: string; recommendation: string | null; record_hash: string | null }>;
    };
    const item = body.alerts.find((a) => a.alert_id === alertId);
    expect(item?.recommendation).toBe("CLOSE_FALSE_POSITIVE");
    expect(item?.record_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("streams a run's events as server-sent events, ending with the run's last event", async () => {
    const { app } = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    await app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: "desk-stream" } });
    const res = await app.inject({ method: "GET", url: "/runs/desk-stream/stream" });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const events = [...res.body.matchAll(/^data: (.*)$/gm)].map(
      (m) => JSON.parse(m[1] as string) as { agent: string; action: string },
    );
    expect(events.length).toBeGreaterThan(10);
    expect(events[0]).toMatchObject({ agent: "system", action: "run_started" });
    expect(events.at(-1)).toMatchObject({ agent: "system", action: "run_completed" });
    expect(new Set(events.map((e) => e.agent))).toContain("critic");
  });

  it("refuses a run id that is not safe to stream", async () => {
    const { app } = await sampleApp();
    expect((await app.inject({ method: "GET", url: "/runs/..%2Fetc/stream" })).statusCode).toBe(404);
  });

  it("returns the sealed record of a reviewed case, and not found for one never reviewed", async () => {
    const { app } = await sampleApp();
    const alertId = alertOf("fp_dob_exact_name_0");
    expect((await app.inject({ method: "GET", url: `/cases/${alertId}/record` })).statusCode).toBe(404);
    await app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: "desk-record" } });
    const res = await app.inject({ method: "GET", url: `/cases/${alertId}/record` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ alert_ref: alertId, decision: "CLOSE_FALSE_POSITIVE" });
  });

  it("returns the facts of a case with identifier numbers masked, and names what was masked", async () => {
    const { app } = await sampleApp();
    const res = await app.inject({ method: "GET", url: `/cases/${alertOf("tm_identifier")}/evidence` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      customer: { customer_id: string };
      customer_identifiers: Array<{ id_number: string }>;
      queries: Array<{ table: string; masked_columns: string[] }>;
      identifier_overlap: string[];
    };
    expect(body.customer.customer_id).toMatch(/^CUST-/);
    expect(body.customer_identifiers.length).toBeGreaterThan(0);
    for (const row of body.customer_identifiers) expect(row.id_number).toMatch(/^\*+.{0,2}$/);
    expect(body.queries.find((q) => q.table.endsWith("customer_identifier"))?.masked_columns).toContain("id_number");
    expect(body.identifier_overlap.length).toBeGreaterThan(0);
  });

  it("returns the exam size and whatever results have been saved", async () => {
    const { app } = await sampleApp();
    const body = (await app.inject({ method: "GET", url: "/exam" })).json() as { cases: number; results: unknown[] };
    expect(body.cases).toBe(70);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("answers the interface's origin and nobody else's", async () => {
    const { app } = await sampleApp();
    const allowed = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:3001" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    const other = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/run",
      headers: { origin: "http://localhost:3001", "access-control-request-method": "POST" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("POST");
  });
});

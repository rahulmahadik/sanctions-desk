import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sampleRules } from "@sanctions-desk/agents";
import type { FetchLike } from "@sanctions-desk/shared";
import {
  createFallbackRulesGenerator,
  loadConfig,
  ReviewResponseSchema,
  resolveProjectPath,
  verifyDecisionRecord,
} from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * The whole review on the committed sample: saved Zetaris answers, the labelled rules-based model, and
 * the real agents, critic checks and policy guard.
 */
/** Add a delay to every answer, so two requests really overlap. */
const slowly =
  (inner: FetchLike, ms: number): FetchLike =>
  async (url, init) => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return inner(url, init);
  };

async function sampleApp(overrides: Record<string, unknown> = {}, delayMs = 0) {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: slowly(replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))), delayMs),
  });
  return makeApp({
    env: { SAMPLE_MODE: "true" },
    overrides,
    zetaris,
    generator: createFallbackRulesGenerator(sampleRules),
    sampleNotice:
      "Sample mode: Zetaris answers are replayed from saved real queries and the model is a labelled rules-based fallback.",
  });
}

const run = (app: Awaited<ReturnType<typeof sampleApp>>["app"], alertId: string, runId = `run-${alertId}`) =>
  app.inject({ method: "POST", url: "/run", payload: { alert_id: alertId, run_id: runId } });

describe("POST /run on the sample", () => {
  it("closes a clear false positive and records every step", async () => {
    const { app, logDir } = await sampleApp();
    const res = await run(app, "ALR-004");
    expect(res.statusCode).toBe(200);
    const body = ReviewResponseSchema.parse(res.json());

    expect(body).toMatchObject({
      status: "ok",
      decision: "CLOSE_FALSE_POSITIVE",
      human_review_required: true,
      approvals_required: 1,
      sample_mode: true,
      policy_version: 1,
      critic: { final_verdict: "approved" },
    });
    expect(body.sample_notice).toContain("Sample mode");
    expect(body.agents).toEqual(["triage", "evidence", "matching", "decision", "critic", "policy_guard", "reporter"]);
    expect(body.citations.length).toBeGreaterThan(5);
    expect(body.citations.every((c) => c.source === "zetaris" && c.query_id.length > 0)).toBe(true);
    expect(body.what_would_change.length).toBeGreaterThan(0);
    expect(body.models.map((m) => [m.agent, m.provider])).toEqual([
      ["decision", "fallback-rules"],
      ["critic", "fallback-rules"],
    ]);

    // The sealed decision record is on disk, verifies, and cites the approved definitions it used.
    const record = JSON.parse(readFileSync(join(logDir, "records", `${body.record_id}.json`), "utf8"));
    expect(verifyDecisionRecord(record)).toBe(true);
    expect(record.record_hash).toBe(body.record_hash);
    expect(record.definitions.map((d: { definition_id: string }) => d.definition_id)).toContain("false_positive");
    expect(record.queries.length).toBeGreaterThan(10);
    expect(record.queries.some((q: { masked_columns: string[] }) => q.masked_columns.includes("id_number"))).toBe(true);

    // The trace holds the same story, one event per step.
    const events = readFileSync(join(logDir, "trace-run-ALR-004.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0].action).toBe("run_started");
    expect(events.at(-1).action).toBe("run_completed");
    expect(new Set(events.map((e) => e.agent))).toEqual(
      new Set(["system", "triage", "evidence", "matching", "decision", "critic", "policy_guard", "reporter"]),
    );
    expect(events.filter((e) => e.zetaris_query_id).length).toBeGreaterThan(8);
  });

  it("never closes a case that carries real risk, across the whole labelled set", async () => {
    const { app } = await sampleApp();
    const cases = JSON.parse(readFileSync(resolveProjectPath("data/sample/bank/cases.json"), "utf8")) as Array<{
      alert_id: string;
      expected: string;
      acceptable: string[];
      scenario: string;
    }>;
    const results: Array<{ id: string; scenario: string; expected: string; got: string }> = [];
    for (const c of cases) {
      const res = await run(app, c.alert_id);
      expect(res.statusCode, c.alert_id).toBe(200);
      results.push({ id: c.alert_id, scenario: c.scenario, expected: c.expected, got: res.json().decision });
    }
    const falseCloses = results.filter(
      (r) => r.got === "CLOSE_FALSE_POSITIVE" && r.expected !== "CLOSE_FALSE_POSITIVE",
    );
    expect(falseCloses).toEqual([]);
    const allowed = new Map(cases.map((c) => [c.alert_id, new Set([c.expected, ...c.acceptable])]));
    expect(results.filter((r) => !allowed.get(r.id)?.has(r.got))).toEqual([]);
  });

  it("refuses to close a customer with missing data and says why", async () => {
    const { app } = await sampleApp();
    const body = (await run(app, "ALR-008")).json();
    expect(body.decision).toBe("NEED_MORE_INFO");
    expect(
      body.guards.some((g: { guard: string; verdict: string }) => g.guard === "data_quality" && g.verdict === "block"),
    ).toBe(true);
  });

  it("does not run the same alert twice at once", async () => {
    const { app } = await sampleApp({}, 5);
    const [a, b] = await Promise.all([run(app, "ALR-005", "run-a"), run(app, "ALR-005", "run-b")]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
  });

  it("reports an alert that does not exist as a structured error", async () => {
    const { app, logDir } = await sampleApp();
    const res = await run(app, "ALR-999", "run-missing");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ status: "error", error: { type: "query_failed" } });
    expect(existsSync(join(logDir, "trace-run-missing.jsonl"))).toBe(true);
  });
});

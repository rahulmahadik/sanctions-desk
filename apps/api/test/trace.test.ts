import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sampleRules } from "@sanctions-desk/agents";
import { examCase, loadExam } from "@sanctions-desk/data";
import { canonicalJson, createFallbackRulesGenerator, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const exam = loadExam();
const caseOf = (kind: string) => examCase(exam, kind);

async function sampleApp() {
  const config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const zetaris = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return makeApp({ env: { SAMPLE_MODE: "true" }, zetaris, generator: createFallbackRulesGenerator(sampleRules) });
}

describe("the decision trace", () => {
  it("answers the four questions for a case from its sealed record", async () => {
    const { app } = await sampleApp();
    await app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: caseOf("tm_identifier").alert_id, run_id: "run-trace-1" },
    });
    const res = await app.inject({ method: "GET", url: `/cases/${caseOf("tm_identifier").alert_id}/trace` });
    expect(res.statusCode).toBe(200);
    const t = res.json();

    expect(t.record.verified).toBe(true);
    expect(t.case).toMatchObject({ alert_ref: caseOf("tm_identifier").alert_id, run_id: "run-trace-1" });
    expect(t.outcome).toMatchObject({ decision: "ESCALATE_L2", human_review_required: true });

    // 1. which approved definitions were applied
    expect(t.definitions.map((d: { definition_id: string }) => d.definition_id)).toContain("true_match");
    expect(
      t.definitions.every(
        (d: { definition_id: string; version: string; statement_hash: string }) =>
          d.version ===
            (d.definition_id === "false_positive" || d.definition_id === "effective_ownership_threshold" ? "2" : "1") &&
          /^[a-f0-9]{64}$/.test(d.statement_hash),
      ),
    ).toBe(true);

    // 2. what data it rested on
    expect(t.data.usl).toMatchObject({ namespace: "lightning.metastore.sanctions" });
    expect(t.data.list_snapshots[0].snapshot_id).toMatch(/^(ofac|un)-/);
    expect(t.data.queries.length).toBeGreaterThan(10);
    expect(t.data.queries[0].sql_hash).toMatch(/^[a-f0-9]{64}$/);

    // 3. who was allowed to see what
    expect(t.access.by_role).toEqual([
      expect.objectContaining({ role: "role_evidence_agent", masked_columns: ["id_number"] }),
    ]);
    expect(t.access.policy.version).toBe(1);

    // 4. what it cost
    // Three safety-guard calls (two verdicts and the narrow check), the screener and the decision.
    expect(t.cost.models.map((m: { provider: string }) => m.provider)).toEqual(Array(5).fill("fallback-rules"));
    expect(t.cost.data_queries.cache_hits).toBe(t.cost.data_queries.count);
    expect(t.cost.totals).toMatchObject({ cloud_calls: 0, total_cost: 0 });
    expect(t.cost.assumption).toContain("assumptions");
  });

  it("is also available by run id", async () => {
    const { app } = await sampleApp();
    await app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: caseOf("fp_dob_exact_name_0").alert_id, run_id: "run-trace-2" },
    });
    const res = await app.inject({ method: "GET", url: "/runs/run-trace-2/trace" });
    expect(res.statusCode).toBe(200);
    expect(res.json().case.alert_ref).toBe(caseOf("fp_dob_exact_name_0").alert_id);
  });

  it("shows the newest recommendation for a case that was reviewed twice", async () => {
    const { app } = await sampleApp();
    await app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: caseOf("fp_dob_exact_name_1").alert_id, run_id: "run-first" },
    });
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: caseOf("fp_dob_exact_name_1").alert_id, run_id: "run-second" },
    });
    expect(
      (await app.inject({ method: "GET", url: `/cases/${caseOf("fp_dob_exact_name_1").alert_id}/trace` })).json().case
        .run_id,
    ).toBe("run-second");
  });

  it("says so when a record has been changed after it was sealed", async () => {
    const { app, logDir } = await sampleApp();
    await app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: caseOf("fp_dob_exact_name_0").alert_id, run_id: "run-tamper" },
    });
    const file = join(logDir, "records", "rec-run-tamper.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.decision = "ESCALATE_L2";
    writeFileSync(file, JSON.stringify(record));
    expect((await app.inject({ method: "GET", url: "/runs/run-tamper/trace" })).json().record.verified).toBe(false);
  });

  it("answers 404 for an unknown case or run, and for an unsafe id", async () => {
    const { app } = await sampleApp();
    for (const url of [
      "/cases/ALR-9404/trace",
      "/runs/never-ran/trace",
      "/cases/..%2F..%2Fx/trace",
      "/runs/..%2Fx/trace",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.type).toBe("not_found");
    }
  });
});

describe("the audit link", () => {
  it("says it cannot ask Zetaris in sample mode", async () => {
    const { app } = await sampleApp();
    await app.inject({
      method: "POST",
      url: "/run",
      payload: { alert_id: caseOf("fp_dob_exact_name_0").alert_id, run_id: "run-audit" },
    });
    const res = await app.inject({ method: "GET", url: "/runs/run-audit/trace?audit=true" });
    expect(res.statusCode).toBe(200);
    expect(res.json().audit).toMatchObject({ available: false });
    expect(res.json().audit.reason).toContain("sample mode");
    // Without the flag the audit section is left out.
    expect((await app.inject({ method: "GET", url: "/runs/run-audit/trace" })).json().audit).toBeUndefined();
  });
});

describe("GET /receipts/:id/verify", () => {
  it("checks a stored receipt: valid signature, pinned key, and what it says about the call", async () => {
    const signed = signedReceiptForTest();
    const { app, config } = await makeApp({ env: { METERLESS_RECEIPT_PUBLIC_KEY: signed.pubkey_b64 } });
    mkdirSync(join(resolveProjectPath(config.logging.dir), "receipts"), { recursive: true });
    writeFileSync(join(resolveProjectPath(config.logging.dir), "receipts", "rcpt_t1.json"), JSON.stringify(signed));
    const res = await app.inject({ method: "GET", url: "/receipts/rcpt_t1/verify" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      receipt_id: "rcpt_t1",
      status: "valid_pinned",
      key_pinned: true,
      app: "sanctions-desk-guard",
      requested_mode: "fast",
      routed_mode: "local",
      mode_coerced: true,
      served_by: "local-runtime/nemotron-3.5-lightning-30b-a3b",
      route_kind: "local",
    });
    expect(res.json().body_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a receipt signed by a key other than the pinned one", async () => {
    const { app, config } = await makeApp();
    const signed = signedReceiptForTest();
    mkdirSync(join(resolveProjectPath(config.logging.dir), "receipts"), { recursive: true });
    writeFileSync(join(resolveProjectPath(config.logging.dir), "receipts", "rcpt_t3.json"), JSON.stringify(signed));
    const res = await app.inject({ method: "GET", url: "/receipts/rcpt_t3/verify" });
    expect(res.json()).toMatchObject({ receipt_id: "rcpt_t3", status: "invalid", key_pinned: false });
  });

  it("reports an altered receipt as invalid, and an unknown or unsafe id as not found", async () => {
    const { app, config } = await makeApp();
    const signed = signedReceiptForTest();
    signed.body.receipt.winning_route.model = "something-else";
    mkdirSync(join(resolveProjectPath(config.logging.dir), "receipts"), { recursive: true });
    writeFileSync(join(resolveProjectPath(config.logging.dir), "receipts", "rcpt_t2.json"), JSON.stringify(signed));
    expect((await app.inject({ method: "GET", url: "/receipts/rcpt_t2/verify" })).json().status).toBe("invalid");
    expect((await app.inject({ method: "GET", url: "/receipts/rcpt_missing/verify" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/receipts/..%2F..%2Fetc/verify" })).statusCode).toBe(404);
  });
});

function signedReceiptForTest() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = {
    signer: "test",
    receipt: {
      app: "sanctions-desk-guard",
      app_policy: { requested_mode: "fast", routed_mode: "local", mode_coerced: true },
      winning_route: { kind: "local", model: "local-runtime/nemotron-3.5-lightning-30b-a3b" },
    },
  };
  const sig = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { body, pubkey_b64: der.subarray(der.length - 32).toString("base64"), sig_b64: sig };
}

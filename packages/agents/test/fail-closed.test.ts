import { AppError, loadConfig, loadPolicyFile, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import type { DecisionOutput, EvidenceBundle, MatchResult } from "../src/index.js";
import { applyPolicyGuard, closeBlockers, dataServiceDown, gatherEvidence, runReview } from "../src/index.js";
import { sampleDeps } from "./helpers.js";

const policy = loadPolicyFile("config/policy.default.json");

const evidence = (safety?: Partial<NonNullable<EvidenceBundle["safety"]>>): EvidenceBundle =>
  ({
    customer: { nationality: "DE", residence_country: "GB" },
    countries: [],
    dq: [],
    freeText: ["An ordinary note with no instruction in it"],
    screener: {
      status: "read",
      fieldsRead: ["customer.notes"],
      truncatedFields: [],
      signals: [],
      documentary: [],
      injection: { flagged: false, spans: [], patternHits: 0 },
      calls: [],
      servedByCloud: false,
    },
    definitionCheck: {
      applied: [
        { definition_id: "true_match", version: "1" },
        { definition_id: "false_positive", version: "2" },
      ],
      mismatched: [],
    },
    ...(safety
      ? {
          safety: {
            violation: true,
            category: "prompt_injection",
            reasons: [],
            patternHits: [],
            modelSaid: undefined,
            calls: [],
            ...safety,
          },
        }
      : {}),
  }) as unknown as EvidenceBundle;

const weak = {
  comparison: {
    subject: "customer",
    definitions: { true_match: false, false_positive: true },
    assessment: "weak",
    dob: { status: "conflict" },
    identifiers: { status: "none" },
    name: { score: 0.6 },
  },
} as unknown as MatchResult;
const close: DecisionOutput = {
  decision: "CLOSE_FALSE_POSITIVE",
  confidence: 0.95,
  rationale: "r",
  facts: [],
  what_would_change: [],
};
const guard = (e: EvidenceBundle) =>
  applyPolicyGuard({ policy, decision: close, match: weak, evidence: e, criticUnresolved: false });

describe("the safety guard's model blocks a close on its own", () => {
  it("lets a close stand when neither the patterns nor the model object", () => {
    expect(guard(evidence()).decision).toBe("CLOSE_FALSE_POSITIVE");
    expect(closeBlockers(policy, evidence(), false)).toEqual([]);
  });

  it("blocks a close when only the guard model flags instruction-like text", () => {
    const e = evidence({ modelSaid: { violation: true, category: "prompt_injection", reasons: ["asks to approve"] } });
    expect(guard(e).decision).toBe("ESCALATE_L2");
    expect(closeBlockers(policy, e, false)).toContain("the safety guard flagged instruction-like text in the data");
  });

  it("blocks a close when the guard model could not check the text", () => {
    const e = evidence({ unchecked: true });
    expect(guard(e).decision).toBe("ESCALATE_L2");
    expect(closeBlockers(policy, e, false)).toContain("the safety guard could not check the free text");
  });
});

describe("a cut-off data-quality list fails closed", () => {
  /** Sample answers, with every SHOW DQ INVALID RECORD answer reporting more rows than it returned. */
  const cutOffDeps = () => {
    const deps = sampleDeps();
    const cache = replayFetch(loadQueryCache(resolveProjectPath(deps.config.sampleCache)));
    const fetchImpl: typeof cache = async (url, init) => {
      const res = await cache(url, init);
      const sql = String((JSON.parse(String(init?.body ?? "{}")) as { sql?: string }).sql ?? "");
      if (res.status !== 200 || !sql.startsWith("SHOW DQ INVALID RECORD")) return res;
      const body = JSON.parse(await res.text()) as { data: unknown[][]; total?: number };
      return new Response(JSON.stringify({ ...body, data: [], total: 999 }), { status: 200 });
    };
    return { ...deps, zetaris: createZetarisClient({ config: deps.config, offline: true, fetchImpl }) };
  };

  it("treats a record missing from a cut-off list as failing the rule, never as passing", async () => {
    const e = await gatherEvidence(cutOffDeps(), "ALR-0004");
    expect(e.dq.length).toBeGreaterThan(0);
    for (const d of e.dq) expect(d).toMatchObject({ failed: true, cutOff: true });
  });

  it("reads an uncut list as before", async () => {
    const e = await gatherEvidence(sampleDeps(), "ALR-0004");
    expect(e.dq.some((d) => d.cutOff)).toBe(false);
  });
});

describe("Zetaris unreachable: the case is held with a reason", () => {
  const downDeps = () => {
    const deps = sampleDeps();
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const config = loadConfig({ env: { SAMPLE_MODE: "true", ZETARIS_TOKEN_EVIDENCE: "test-token" } });
    return { ...deps, zetaris: createZetarisClient({ config, fetchImpl: fetchImpl as never }) };
  };

  it("knows a connection failure to Zetaris from a refused query", () => {
    const deps = sampleDeps();
    const url = `${deps.config.zetaris.restUrl}/sql-editor/sqls/run`;
    expect(dataServiceDown(deps, new AppError("network", "network error", { details: { url } }))).toBe(true);
    expect(dataServiceDown(deps, new AppError("timeout", "timed out", { details: { url } }))).toBe(true);
    expect(dataServiceDown(deps, new AppError("query_failed", "x", { details: { status: 503 } }))).toBe(true);
    expect(dataServiceDown(deps, new AppError("query_failed", "x", { details: { status: 404 } }))).toBe(false);
    expect(dataServiceDown(deps, new AppError("network", "x", { details: { url: "http://other/v1" } }))).toBe(false);
    expect(dataServiceDown(deps, new Error("x"))).toBe(false);
  });

  it("answers with a hold for a person, the reason, and no recommendation of its own", async () => {
    const r = await runReview(downDeps(), { runId: "down-1", alertId: "ALR-0004", sampleMode: false });
    expect(r).toMatchObject({
      status: "ok",
      decision: "ESCALATE_L2",
      confidence: 0,
      held_reason: "data_service_unavailable",
      human_review_required: true,
    });
    expect(r.rationale).toContain("could not be reached");
    expect(r.record_hash).toBeUndefined();
  });
});

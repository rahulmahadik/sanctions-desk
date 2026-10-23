import type { Generator } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { gatherEvidence, runReview } from "../src/index.js";
import type { Row } from "../src/types.js";
import { caseFacts, sampleDeps } from "./helpers.js";

/**
 * Decisions that people made on this desk come back as memories of the next review of the same customer and listed
 * entry: citeable, re-checked against the entry as it is now, and replaced by a later decision.
 */
const c = caseFacts("fp_dob_exact_name_0");
const safe = JSON.stringify({ violation: false, category: "none", reasons: [] });
const approve = JSON.stringify({ verdict: "approve", issues: [] });

async function entryHash(): Promise<string> {
  const evidence = await gatherEvidence(sampleDeps(), c.alertId);
  return evidence.entry.content_hash ?? "";
}

const row = (over: Partial<Row>, hash: string): Row => ({
  disposition_id: "dsk-rec-1",
  customer_id: c.customerId,
  entry_id: c.entryId,
  entry_content_hash: hash,
  list_snapshot_id: null,
  decision: "CLOSE_FALSE_POSITIVE",
  reason_codes: "ANALYST_APPROVE",
  decided_at: "2026-10-23T09:00:00.000Z",
  decided_by: "ana",
  reason: "Dates of birth differ by 14 years; passport checked.",
  ...over,
});

/** A model that cites the first recalled memory by the id it finds in the prompt. */
function citing(column: string, value: string): { generator: Generator; prompts: string[] } {
  const prompts: string[] = [];
  const generator: Generator = async (req) => {
    prompts.push(req.prompt);
    const answer = req.prompt.includes("TASK: decision")
      ? JSON.stringify({
          decision: "CLOSE_FALSE_POSITIVE",
          confidence: 0.9,
          rationale: "Dates of birth conflict; a person closed the same pair before.",
          facts: [
            { table: "customer", key_value: c.customerId, column: "full_name", value: c.customerName },
            {
              table: "memory",
              key_value: /"memory_id":"([^"]+)"/.exec(req.prompt)?.[1] ?? "none",
              column,
              value,
            },
          ],
          what_would_change: [],
        })
      : req.prompt.includes("TASK: critic")
        ? approve
        : safe;
    return {
      text: answer,
      provider: "fallback-rules",
      requestedModel: "t",
      routedModel: "t",
      routeKind: "local",
      latencyMs: 1,
      modeMismatch: false,
    };
  };
  return { generator, prompts };
}

const review = (generator: Generator, rows: Row[], runId: string) =>
  runReview(
    { ...sampleDeps({ generator }), analystDecisions: () => rows },
    { runId, alertId: c.alertId, sampleMode: true },
  );

describe("a decision made on this desk, recalled in a later review", () => {
  it("shows the decision, who made it and why, as a fresh memory the model can cite", async () => {
    const { generator, prompts } = citing("decided_by", "ana");
    const res = await review(generator, [row({}, await entryHash())], "am-cite");
    const decisionPrompt = prompts.find((p) => p.includes("TASK: decision")) ?? "";
    expect(decisionPrompt).toContain('"source":"desk_decision"');
    expect(decisionPrompt).toContain('"decided_by":"ana"');
    expect(decisionPrompt).toContain("fresh: the listed entry has not changed since");
    expect(res.critic?.final_verdict).toBe("approved");
  });

  it("checks a citation of the memory against what was recalled: a wrong claim is never approved", async () => {
    const { generator } = citing("decided_by", "someone_else");
    const res = await review(generator, [row({}, await entryHash())], "am-wrong");
    expect(res.critic?.final_verdict).not.toBe("approved");
    expect(res.rationale).toMatch(/memory\.decided_by is "ana"|critic|escalat/i);
  });

  it("goes stale when the listed entry changed since the decision, and then cannot support a close on its own", async () => {
    const { generator, prompts } = citing("state", "stale");
    await review(generator, [row({}, "f".repeat(64))], "am-stale");
    const decisionPrompt = prompts.find((p) => p.includes("TASK: decision")) ?? "";
    expect(decisionPrompt).toContain("stale: the listed entry changed since");
  });

  it("is replaced by a later decision of a person: the earlier one is marked overridden", async () => {
    const hash = await entryHash();
    const rows = [
      row(
        { disposition_id: "dsk-rec-1", decision: "CLOSE_FALSE_POSITIVE", decided_at: "2026-10-23T08:00:00.000Z" },
        hash,
      ),
      row(
        {
          disposition_id: "dsk-rec-2",
          decision: "ESCALATE_L2",
          decided_at: "2026-10-23T09:30:00.000Z",
          decided_by: "off",
          reason: "New information from the relationship manager.",
        },
        hash,
      ),
    ];
    const { generator, prompts } = citing("decision", "ESCALATE_L2");
    await review(generator, rows, "am-override");
    const decisionPrompt = prompts.find((p) => p.includes("TASK: decision")) ?? "";
    expect(decisionPrompt).toContain("overridden");
    expect(decisionPrompt).toContain('"decided_by":"off"');
  });

  it("is left out of evaluation runs, which do not pass the source", async () => {
    const { generator, prompts } = citing("decision", "CLOSE_FALSE_POSITIVE");
    await runReview(sampleDeps({ generator }), { runId: "am-none", alertId: c.alertId, sampleMode: true });
    expect(prompts.find((p) => p.includes("TASK: decision"))).toContain('"earlier_decisions":[]');
  });
});

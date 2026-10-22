import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DecisionRecord,
  type GuardVerdictInput,
  type ModelUseInput,
  policyRef,
  type QueryEvidenceInput,
  sealDecisionRecord,
} from "@sanctions-desk/shared";
import type { DecisionOutput } from "./decision.js";
import type { EvidenceBundle } from "./evidence.js";
import type { GuardOutcome } from "./policy-guard.js";
import type { AgentDeps } from "./types.js";

/** The Reporter seals everything that was known at decision time into a hash-protected record. */

export interface RecordInput {
  deps: AgentDeps;
  runId: string;
  alertId: string;
  evidence: EvidenceBundle;
  decision: DecisionOutput;
  guard: GuardOutcome;
  rationale: string;
  criticQueries: QueryEvidenceInput[];
  models: ModelUseInput[];
  criticRounds: number;
  criticVerdict: "approved" | "rejected" | "escalated" | "not_run";
}

export function buildDecisionRecord(input: RecordInput): DecisionRecord {
  const { deps, evidence, guard } = input;
  const at = deps.now().toISOString();
  return sealDecisionRecord({
    record_id: `rec-${input.runId}`,
    run_id: input.runId,
    alert_type: "customer",
    alert_ref: input.alertId,
    decided_at: at,
    as_of: at,
    decision: guard.decision,
    confidence: guard.confidence,
    ...(guard.changed
      ? {
          confidence_cap: {
            value: guard.confidence,
            reason: guard.verdicts
              .filter((v) => v.verdict === "block")
              .map((v) => v.guard)
              .join(", "),
          },
        }
      : {}),
    rationale: input.rationale,
    what_would_change: input.decision.what_would_change,
    policy: policyRef(deps.policy),
    definitions: evidence.definitionCheck.applied,
    usl: { namespace: deps.config.zetaris.namespace, model_version: evidence.model.version },
    list_snapshots: [
      {
        list: (evidence.entry.list_id === "UN" ? "UN" : "OFAC") as "OFAC" | "UN",
        snapshot_id: evidence.entry.snapshot_id ?? "unknown",
        ...(evidence.entry.content_hash ? { content_hash: evidence.entry.content_hash } : {}),
      },
    ],
    queries: [...evidence.queries, ...input.criticQueries],
    memories: [],
    models: input.models,
    guards: guard.verdicts as GuardVerdictInput[],
    critic: { rounds: input.criticRounds, final_verdict: input.criticVerdict },
  });
}

/** Records are written beside the traces, one file each. They are never edited afterwards. */
export function writeDecisionRecord(dir: string, record: DecisionRecord): string {
  const folder = join(dir, "records");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${record.record_id}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640 });
  return file;
}

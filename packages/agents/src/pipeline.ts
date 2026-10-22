import {
  AppError,
  type Citation,
  type ModelUseInput,
  type QueryEvidenceInput,
  type ReviewResponse,
  ReviewResponseSchema,
} from "@sanctions-desk/shared";
import { buildEvidenceTools } from "@sanctions-desk/zetaris";
import { review } from "./critic.js";
import { type DecisionOutput, decide } from "./decision.js";
import { gatherEvidence } from "./evidence.js";
import { matchEvidence } from "./matching.js";
import { applyPolicyGuard } from "./policy-guard.js";
import { buildDecisionRecord, writeDecisionRecord } from "./record.js";
import { judgeDifficulty, triage } from "./triage.js";
import type { AgentDeps } from "./types.js";

/**
 * One review, start to finish: Triage, Evidence, Matching, Decision, Critic (up to the policy's round
 * limit), Policy guard, Reporter. The result is a recommendation for a person to act on.
 */

export interface ReviewRequest {
  runId: string;
  alertId: string;
  sampleMode: boolean;
  sampleNotice?: string;
}

const AGENT_ORDER = ["triage", "evidence", "matching", "decision", "critic", "policy_guard", "reporter"];

export async function runReview(deps: AgentDeps, request: ReviewRequest): Promise<ReviewResponse> {
  const started = performance.now();
  const { trace, policy } = deps;
  triage(deps, "customer", request.alertId);

  const evidence = await gatherEvidence(deps, request.alertId);
  if (evidence.alert.alert_source === "ownership") {
    throw new AppError("not_implemented", "ownership alerts are not reviewed in this build yet");
  }
  const match = matchEvidence(deps, evidence);
  judgeDifficulty(deps, match);

  const tools = buildEvidenceTools(evidence.model, deps.zetaris, {
    role: "evidence",
    defaultLimit: deps.config.zetaris.maxRows,
    maskSensitive: true,
  });

  const models: ModelUseInput[] = [];
  const criticQueries: QueryEvidenceInput[] = [];
  let output: DecisionOutput | undefined;
  let feedback: string[] = [];
  let rounds = 0;
  let approved = false;

  while (rounds < policy.critic.maxRounds && !approved) {
    rounds += 1;
    const decision = await decide(deps, evidence, match, feedback);
    models.push(...decision.calls);
    output = decision.output;
    const verdict = await review(deps, tools, evidence, match, output);
    models.push(...verdict.calls);
    criticQueries.push(...verdict.checks.flatMap((c) => (c.evidence ? [c.evidence] : [])));
    approved = verdict.approved;
    feedback = verdict.issues;
    if (!approved && rounds < policy.critic.maxRounds) {
      trace.log({
        agent: "critic",
        action: "send_back",
        status: "retry",
        retry_count: rounds,
        target_agent: "decision",
        output_summary: verdict.issues.join("; ").slice(0, 300),
      });
    }
  }
  if (!output) throw new AppError("internal", "no recommendation was produced");

  const guard = applyPolicyGuard({ policy, decision: output, match, evidence, criticUnresolved: !approved });
  trace.log({
    agent: "policy_guard",
    action: "apply_policy",
    status: guard.changed ? "blocked" : "ok",
    confidence: guard.confidence,
    output_summary: guard.changed ? `${output.decision} raised to ${guard.decision}` : `${guard.decision} stands`,
    detail: { verdicts: guard.verdicts.map((v) => `${v.guard}:${v.verdict}`) },
  });

  const reasons = guard.verdicts
    .filter((v) => v.verdict === "block")
    .map((v) => v.detail)
    .filter((d): d is string => !!d);
  const rationale = guard.changed ? `${output.rationale} Policy check: ${reasons.join("; ")}.` : output.rationale;
  const criticVerdict = approved ? "approved" : "escalated";
  const record = buildDecisionRecord({
    deps,
    runId: request.runId,
    alertId: request.alertId,
    evidence,
    decision: output,
    guard,
    rationale,
    criticQueries,
    models,
    criticRounds: rounds,
    criticVerdict,
  });
  const file = writeDecisionRecord(deps.config.logging.dir, record);
  trace.log({
    agent: "reporter",
    action: "seal_record",
    status: "ok",
    output_summary: `record ${record.record_id} sealed`,
    detail: { record_hash: record.record_hash, file },
  });

  const citations: Citation[] = evidence.citations.map((c) => ({ ...c, row_keys: c.row_keys }));
  return ReviewResponseSchema.parse({
    run_id: request.runId,
    status: "ok",
    alert_type: evidence.alert.alert_type === "payment" ? "payment" : "customer",
    policy_version: policy.version,
    decision: guard.decision,
    confidence: guard.confidence,
    rationale,
    what_would_change: output.what_would_change,
    citations,
    agents: AGENT_ORDER,
    models: record.models,
    guards: record.guards,
    critic: record.critic,
    record_id: record.record_id,
    record_hash: record.record_hash,
    human_review_required: true,
    approvals_required: guard.approvalsRequired,
    trace_id: request.runId,
    execution_time_seconds: (performance.now() - started) / 1000,
    ...(request.sampleMode ? { sample_mode: true, sample_notice: request.sampleNotice } : {}),
  });
}

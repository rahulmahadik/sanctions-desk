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
import { type MatchResult, matchEvidence, partyOf } from "./matching.js";
import { recallMemory } from "./memory.js";
import { gatherOwnership, matchOwnership, ownershipQuality } from "./ownership.js";
import { applyPolicyGuard } from "./policy-guard.js";
import { buildDecisionRecord, writeDecisionRecord } from "./record.js";
import { screenInbound } from "./safety.js";
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
  /** Switches for comparing the system with simpler setups. Both are on in normal use. */
  options?: { memory?: boolean; critic?: boolean };
}

const AGENT_ORDER = ["triage", "evidence", "matching", "memory", "decision", "critic", "policy_guard", "reporter"];

/** Everything read and worked out before a recommendation is asked for. */
async function prepare(deps: AgentDeps, alertId: string, options: ReviewRequest["options"]) {
  const evidence = await gatherEvidence(deps, alertId);
  // Text that came out of the data is read as data. Anything that tries to instruct the reviewer is flagged first.
  const inbound = await screenInbound(deps, evidence.freeText);
  evidence.safety = inbound;

  let match: MatchResult;
  if (evidence.alert.alert_source === "ownership") {
    const ownership = await gatherOwnership(
      deps,
      evidence.model,
      evidence.customer.customer_id ?? "",
      evidence.queries,
    );
    evidence.ownership = ownership;
    evidence.dq.push(...(await ownershipQuality(deps, evidence.model, ownership.rows, evidence.queries)));
    match = matchOwnership(deps, evidence, ownership, partyOf(evidence));
  } else {
    match = matchEvidence(deps, evidence);
  }
  judgeDifficulty(deps, match);

  const tools = buildEvidenceTools(evidence.model, deps.zetaris, {
    role: "evidence",
    defaultLimit: deps.config.zetaris.maxRows,
    maskSensitive: true,
  });
  const memory = options?.memory === false ? undefined : await recallMemory(deps, tools, evidence, evidence.queries);
  if (memory) evidence.memory = memory;
  // A still-valid earlier clearance on a case the definitions also call a false positive is an easy case:
  // the fast local model is enough and no reasoning is spent.
  const easy = memory?.fresh === true && match.comparison.definitions.false_positive;
  if (easy) {
    deps.trace.log({
      agent: "triage",
      action: "route",
      status: "ok",
      output_summary: "earlier clearance still valid: fast path, no reasoning",
    });
  }
  return { evidence, match, tools, easy, models: [...inbound.calls] as ModelUseInput[] };
}

/** The Decision and Critic loop, up to the number of rounds the policy allows. */
async function deliberate(
  deps: AgentDeps,
  prepared: Awaited<ReturnType<typeof prepare>>,
  options: ReviewRequest["options"],
) {
  const { evidence, match, tools, easy, models } = prepared;
  const { policy, trace } = deps;
  const criticQueries: QueryEvidenceInput[] = [];
  let output: DecisionOutput | undefined;
  let feedback: string[] = [];
  let rounds = 0;
  let approved = false;

  if (options?.critic === false) {
    // Comparison setup: one recommendation, no critic. The policy guard still applies afterwards.
    const decision = await decide(deps, evidence, match, [], { fast: easy });
    models.push(...decision.calls);
    return { output: decision.output, approved: true, rounds: 0, criticQueries, models, criticRan: false };
  }

  while (rounds < policy.critic.maxRounds && !approved) {
    rounds += 1;
    const decision = await decide(deps, evidence, match, feedback, { fast: easy });
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
  return { output, approved, rounds, criticQueries, models, criticRan: true };
}

export async function runReview(deps: AgentDeps, request: ReviewRequest): Promise<ReviewResponse> {
  const started = performance.now();
  const { trace, policy } = deps;
  triage(deps, "customer", request.alertId);

  const prepared = await prepare(deps, request.alertId, request.options);
  const { evidence, match } = prepared;
  const { output, approved, rounds, criticQueries, models, criticRan } = await deliberate(
    deps,
    prepared,
    request.options,
  );

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
    criticVerdict: !criticRan ? "not_run" : approved ? "approved" : "escalated",
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

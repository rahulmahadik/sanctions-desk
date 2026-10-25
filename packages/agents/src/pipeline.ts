import { relative } from "node:path";
import {
  AppError,
  type Citation,
  type DecisionRecord,
  type ModelUseInput,
  type NotCitable,
  type QueryEvidenceInput,
  type ReviewResponse,
  ReviewResponseSchema,
} from "@sanctions-desk/shared";
import { buildEvidenceTools } from "@sanctions-desk/zetaris";
import { decideAutonomy, randomDraw } from "./autonomy.js";
import { challenge, challengeTriggers } from "./challenger.js";
import { review } from "./critic.js";
import { type DecisionOutput, type DecisionResult, decide } from "./decision.js";
import { type EvidenceBundle, gatherEvidence } from "./evidence.js";
import { firstFinding } from "./hybrid.js";
import { type MatchResult, matchEvidence, partyOf } from "./matching.js";
import { recallMemory } from "./memory.js";
import { applyNoteDocumentCheck, checkNoteDocument } from "./note-document.js";
import { gatherOwnership, matchOwnership, ownershipQuality } from "./ownership.js";
import { applyPolicyGuard, closeBlockers } from "./policy-guard.js";
import { buildDecisionRecord, writeDecisionRecord } from "./record.js";
import { screenInbound } from "./safety.js";
import { screenFreeText } from "./screener.js";
import { judgeDifficulty, triage } from "./triage.js";
import { type AgentDeps, clientFor } from "./types.js";

/**
 * One review, start to finish: Triage, Evidence, Screener, Matching, Memory, Decision, Critic (up to the policy's
 * round limit), Policy guard, Challenger (on a close that survives the guard), Reporter. The result is a recommendation for a person to act on.
 */

export interface ReviewRequest {
  runId: string;
  alertId: string;
  sampleMode: boolean;
  sampleNotice?: string;
  /** Switches for comparing the system with simpler setups. Both are on in normal use. */
  options?: { memory?: boolean; critic?: boolean; challenger?: boolean };
}

const AGENT_ORDER = [
  "triage",
  "evidence",
  "screener",
  "matching",
  "memory",
  "decision",
  "critic",
  "policy_guard",
  "reporter",
];
const CHALLENGER_AT = AGENT_ORDER.indexOf("policy_guard");

/** Everything read and worked out before a recommendation is asked for. */
async function prepare(deps: AgentDeps, alertId: string, options: ReviewRequest["options"]) {
  const evidence = await gatherEvidence(deps, alertId);
  // The plan names the alert's type as the data gives it (the same value the sealed record keeps).
  triage(deps, evidence.alert.alert_type === "payment" ? "payment" : "customer", alertId);
  // Text that came out of the data is read as data. Anything that tries to instruct the reviewer is flagged first.
  const inbound = await screenInbound(deps, evidence.freeText);
  evidence.safety = inbound;
  // The local screener reads the notes, payment references and list remarks and keeps only structured facts. Matching
  // and the cloud steps work from those facts; the text itself stays on the machine.
  const screened = await screenFreeText(deps, evidence);
  evidence.screener = screened;
  // A documentary note's document number must be one of the customer's documents: one count inside Zetaris.
  const noteDocument = await checkNoteDocument(deps, evidence);
  if (noteDocument) {
    evidence.noteDocument = noteDocument;
    applyNoteDocumentCheck(screened, noteDocument);
  }
  // One local model's say-so is not enough to mark the data as instructing the reviewer: the screener's verdict counts
  // only with a pattern hit (when the inbound guard already agrees, the data is marked already).
  if (screened.injection.flagged && screened.injection.patternHits > 0 && !inbound.violation) {
    evidence.safety = {
      ...inbound,
      violation: true,
      category: "prompt_injection",
      reasons: [...inbound.reasons, "the screener found text that tries to instruct the reviewer"],
    };
  }

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
    match.closeBlockers = closeBlockers(deps.policy, evidence, false);
  } else {
    match = matchEvidence(deps, evidence);
  }
  judgeDifficulty(deps, match);

  const toolOptions = { role: "evidence", defaultLimit: deps.config.zetaris.maxRows, maskSensitive: true } as const;
  // Memory reads earlier decisions under the evidence step's access; the critic has its own, narrower one.
  const tools = buildEvidenceTools(evidence.model, clientFor(deps, "evidence"), toolOptions);
  // The critic's reads leave out the columns it may not name, so the other columns of such a table can be checked.
  const criticTools = buildEvidenceTools(evidence.model, clientFor(deps, "critic"), {
    ...toolOptions,
    role: "critic",
    omitColumns: deps.policy.agentAccess.critic.denyColumns,
  });
  // Memory reads earlier decisions under the evidence step's scope, as its own identity when one is set up.
  const memoryTools = buildEvidenceTools(evidence.model, clientFor(deps, "evidence"), {
    ...toolOptions,
    role: "memory",
  });
  const memory =
    options?.memory === false ? undefined : await recallMemory(deps, memoryTools, evidence, evidence.queries);
  if (memory) evidence.memory = memory;
  // The hybrid: code gives a first finding from the structured fields; the path says whether the agents confirm it
  // or have to reason over the free text.
  evidence.hybrid = firstFinding(evidence, match);
  deps.trace.log({
    agent: "triage",
    action: "path",
    status: "ok",
    output_summary: `${evidence.hybrid.path}: ${evidence.hybrid.why}`.slice(0, 300),
    detail: { first_finding: evidence.hybrid.decision, settled: evidence.hybrid.settled, path: evidence.hybrid.path },
  });
  // A still-valid earlier clearance on a case the definitions also call a false positive is an easy case, and so is
  // one the structured evidence settles: the fast local model is enough and no reasoning is spent.
  const easy =
    (memory?.fresh === true && match.comparison.definitions.false_positive) || evidence.hybrid.path === "confirm";
  if (easy) {
    // The words name whichever of the two reasons for the fast path held; the path itself is the same.
    const why =
      memory?.fresh === true && match.comparison.definitions.false_positive
        ? "earlier clearance still valid"
        : "the structured evidence settles it";
    deps.trace.log({
      agent: "triage",
      action: "route",
      status: "ok",
      output_summary: `${why}: fast path, no reasoning`,
    });
  }
  return {
    evidence,
    match,
    tools,
    criticTools,
    easy,
    models: [...inbound.calls, ...screened.calls] as ModelUseInput[],
  };
}

/** The lines a reviewer should read first: what the comparison found, then the check that changed the outcome. */
function keyEvidence(match: MatchResult, guard: ReturnType<typeof applyPolicyGuard>): string[] {
  const lines = match.comparison.reasons.slice(0, 2).map((r) => `Comparison: ${r}`);
  if (match.documentaryDateOfBirth !== undefined)
    lines.unshift(
      `Date of birth ${match.documentaryDateOfBirth} from verified note (check ref ${match.documentaryCheckReference}), not from the customer record`,
    );
  const changed = guard.verdicts.find((v) => v.verdict === "block" && v.detail);
  if (changed?.detail) lines.push(`Check: ${changed.guard.replaceAll("_", " ")}: ${changed.detail}`.slice(0, 220));
  return lines.slice(0, 3);
}

/** Run the challenger when the policy's triggers apply to a close, and say what it changed. */
async function challengeClose(deps: AgentDeps, evidence: EvidenceBundle, match: MatchResult, output: DecisionOutput) {
  const reasons = challengeTriggers(deps.policy, output, match, evidence);
  if (reasons.length === 0) return undefined;
  const result = await challenge(deps, evidence, match, output, reasons);
  const credible = result.challenge?.credible === true;
  if (result.challenge && !credible) {
    return {
      calls: result.calls,
      output: undefined,
      verdict: {
        guard: "challenger",
        verdict: "pass" as const,
        detail: `ran (${reasons.join("; ")}); no credible true-match argument`,
      },
    };
  }
  const why = credible
    ? (result.challenge?.argument ?? "")
    : `the challenger could not answer: ${result.unavailable ?? "unknown"}`;
  return {
    calls: result.calls,
    output: {
      ...output,
      decision: "ESCALATE_L2" as const,
      confidence: Math.min(output.confidence, 0.6),
      rationale:
        `${output.rationale} Challenger: ${credible ? "a credible true-match argument was found" : "the close could not be challenged"}: ${why}`.slice(
          0,
          1500,
        ),
      what_would_change: [...output.what_would_change, "A person's review of the challenger's argument"].slice(0, 6),
    },
    verdict: {
      guard: "challenger",
      verdict: "block" as const,
      detail: `${credible ? "credible argument: " : ""}${why}`.slice(0, 300),
    },
  };
}

/** The Decision and Critic loop, up to the number of rounds the policy allows. */
async function deliberate(
  deps: AgentDeps,
  prepared: Awaited<ReturnType<typeof prepare>>,
  options: ReviewRequest["options"],
) {
  const { evidence, match, criticTools, easy, models } = prepared;
  const { policy, trace } = deps;
  const criticQueries: QueryEvidenceInput[] = [];
  const notCitable: NotCitable[] = [];
  let output: DecisionOutput | undefined;
  let feedback: string[] = [];
  let rounds = 0;
  let approved = false;
  let last: DecisionResult | undefined;

  if (options?.critic === false) {
    // Comparison setup: one recommendation, no critic. The policy guard still applies afterwards.
    const decision = await decide(deps, evidence, match, [], { fast: easy });
    models.push(...decision.calls);
    return {
      output: decision.output,
      approved: true,
      rounds: 0,
      criticQueries,
      models,
      criticRan: false,
      unavailable: decision.unavailable,
      last: decision,
      notCitable,
    };
  }

  while (rounds < policy.critic.maxRounds && !approved) {
    rounds += 1;
    const decision = await decide(deps, evidence, match, feedback, { fast: easy });
    models.push(...decision.calls);
    output = decision.output;
    last = decision;
    // No usable recommendation: the critic has nothing to check, and a person gets the case.
    if (decision.unavailable) {
      return {
        output,
        approved: true,
        rounds: 0,
        criticQueries,
        models,
        criticRan: false,
        unavailable: decision.unavailable,
        last: decision,
        notCitable,
      };
    }
    const verdict = await review(deps, criticTools, evidence, match, output, { round: rounds });
    models.push(...verdict.calls);
    notCitable.push(...verdict.notCitable);
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
  return { output, approved, rounds, criticQueries, models, criticRan: true, unavailable: undefined, last, notCitable };
}

/** Values the review took from verified notes, shown as such and never as values of the customer record. */
function documentaryOf(match: MatchResult): DecisionRecord["documentary"] {
  if (match.documentaryDateOfBirth === undefined || match.documentaryCheckReference === undefined) return undefined;
  return [
    {
      field: "date_of_birth" as const,
      value: match.documentaryDateOfBirth,
      source: "customer.notes",
      check_reference: match.documentaryCheckReference,
      label: `date of birth from verified note (check ref ${match.documentaryCheckReference})`,
    },
  ];
}

const unmetNames = (a: NonNullable<DecisionRecord["autonomy"]>): string =>
  a.conditions
    .filter((c) => !c.met)
    .map((c) => c.name)
    .join(", ") || "sampled for quality assurance";

/** What the autonomy setting does with this recommendation. At level 0 nothing is recorded: a person decides. */
function autonomyOf(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  modelDecision: DecisionOutput["decision"],
  guard: ReturnType<typeof applyPolicyGuard>,
  criticVerdict: "approved" | "rejected" | "escalated" | "not_run",
): DecisionRecord["autonomy"] {
  if (deps.policy.autonomy.level !== 1) return undefined;
  const autonomy = decideAutonomy({
    policy: deps.policy,
    killSwitch: deps.killSwitch?.() ?? false,
    final: guard.decision,
    modelDecision,
    firstFinding: evidence.hybrid
      ? { decision: evidence.hybrid.decision, settled: evidence.hybrid.settled }
      : undefined,
    confidence: guard.confidence,
    critic: { final_verdict: criticVerdict },
    guards: guard.verdicts,
    dataQualityFailed: evidence.dq.some((d) => d.failed),
    screener: evidence.screener
      ? {
          status: evidence.screener.status,
          signals: evidence.screener.signals.length,
          servedByCloud: evidence.screener.servedByCloud,
          truncated: evidence.screener.truncatedFields.length > 0,
        }
      : undefined,
    autoClosedToday: deps.autoClosedToday?.() ?? 0,
    draw: deps.random?.() ?? randomDraw(),
  });
  deps.trace.log({
    agent: "policy_guard",
    action: "autonomy",
    status: "ok",
    output_summary: autonomy.statement ?? `${autonomy.outcome}: ${unmetNames(autonomy)}`,
    detail: { outcome: autonomy.outcome, level_in_force: autonomy.level_in_force },
  });
  return autonomy;
}

/** The policy guard, then the challenger's last look at a close, then the guard again if the challenger changed it. */
async function settle(
  deps: AgentDeps,
  request: ReviewRequest,
  prepared: Awaited<ReturnType<typeof prepare>>,
  deliberated: Awaited<ReturnType<typeof deliberate>>,
) {
  const { evidence, match } = prepared;
  const { output, approved, models, unavailable } = deliberated;
  const { policy } = deps;
  let finalOutput = output;
  let guard = applyPolicyGuard({ policy, decision: output, match, evidence, criticUnresolved: !approved });
  // A close that the policy guard has not already raised gets a last look from the challenger, when the policy
  // says it is the kind of close worth doubting.
  const challenged =
    unavailable || request.options?.challenger === false || guard.decision !== "CLOSE_FALSE_POSITIVE"
      ? undefined
      : await challengeClose(deps, evidence, match, output);
  if (challenged) {
    models.push(...challenged.calls);
    if (challenged.output) {
      finalOutput = challenged.output;
      guard = applyPolicyGuard({ policy, decision: finalOutput, match, evidence, criticUnresolved: !approved });
    }
    guard.verdicts.push(challenged.verdict);
  }
  if (unavailable) {
    guard.verdicts.push({ guard: "model_decision", verdict: "block", detail: unavailable });
    guard.confidence = Math.min(guard.confidence, 0.3);
  }
  deps.trace.log({
    agent: "policy_guard",
    action: "apply_policy",
    status: guard.changed ? "blocked" : "ok",
    confidence: guard.confidence,
    output_summary: guard.changed ? `${finalOutput.decision} raised to ${guard.decision}` : `${guard.decision} stands`,
    detail: { verdicts: guard.verdicts.map((v) => `${v.guard}:${v.verdict}`) },
  });
  return { finalOutput, guard, challenged: challenged !== undefined };
}

const rationaleOf = (finalOutput: DecisionOutput, guard: ReturnType<typeof applyPolicyGuard>): string => {
  const reasons = guard.verdicts
    .filter((v) => v.verdict === "block")
    .map((v) => v.detail)
    .filter((d): d is string => !!d);
  return guard.changed ? `${finalOutput.rationale} Policy check: ${reasons.join("; ")}.` : finalOutput.rationale;
};

/**
 * Who made the recommendation: the model and route of the answer that was used, whether a fallback produced it, the
 * model's own last recommendation before the challenger and the guard, and whether the critic was left unresolved.
 */
function decisionSource(deliberated: Awaited<ReturnType<typeof deliberate>>) {
  const { last, output, approved, criticRan } = deliberated;
  const call = last?.calls.at(-1);
  const route = last?.route;
  return {
    ...(call ? { decision_model: call.model_routed } : {}),
    ...(route ? { decision_route: route } : {}),
    decided_by_fallback:
      last?.unavailable !== undefined ||
      (route !== undefined && route !== "own") ||
      call?.provider === "ollama" ||
      call?.provider === "fallback-rules",
    model_last_recommendation: output.decision,
    critic_unresolved: criticRan && !approved,
  };
}

/**
 * True when Zetaris itself could not be reached (no connection, a time-out, or a server error), as opposed to a query
 * Zetaris refused or a case the data cannot answer.
 */
export function dataServiceDown(deps: Pick<AgentDeps, "config">, err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  const url = String((err.details as { url?: unknown } | undefined)?.url ?? "");
  const fromZetaris = url === "" || url.startsWith(deps.config.zetaris.restUrl);
  if ((err.type === "network" || err.type === "timeout") && fromZetaris) return true;
  const status = Number((err.details as { status?: unknown } | undefined)?.status ?? 0);
  return err.type === "query_failed" && status >= 500;
}

/**
 * The answer when the data service is down: nothing was read or checked, so nothing is recommended. The alert is held
 * for a person (escalated with the reason) and must be reviewed again when Zetaris is back. No record is sealed,
 * because there is no evidence to seal.
 */
function heldForDataService(deps: AgentDeps, request: ReviewRequest, started: number, err: AppError): ReviewResponse {
  const reason = `The data service (Zetaris) could not be reached (${err.message.slice(0, 120)}), so nothing was read or checked. The alert is held for a person and must be reviewed again when the data service is back.`;
  deps.trace.log({
    agent: "evidence",
    action: "data_service_unavailable",
    status: "blocked",
    output_summary: "held for a person: the data service could not be reached",
    detail: { error_type: err.type },
  });
  return ReviewResponseSchema.parse({
    run_id: request.runId,
    status: "ok",
    policy_version: deps.policy.version,
    decision: "ESCALATE_L2",
    confidence: 0,
    rationale: reason,
    what_would_change: ["Review the alert again once the data service answers."],
    key_evidence: ["the data service could not be reached; nothing was read or checked"],
    agents: ["triage", "evidence"],
    held_reason: "data_service_unavailable",
    human_review_required: true,
    trace_id: request.runId,
    execution_time_seconds: Math.round((performance.now() - started) / 10) / 100,
    ...(request.sampleMode ? { sample_mode: true, sample_notice: request.sampleNotice } : {}),
  });
}

export async function runReview(deps: AgentDeps, request: ReviewRequest): Promise<ReviewResponse> {
  const started = performance.now();
  const { trace, policy } = deps;

  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(deps, request.alertId, request.options);
  } catch (err) {
    // Fail closed with a reason: a review that cannot reach its data is held for a person, not stopped by an error.
    if (dataServiceDown(deps, err)) return heldForDataService(deps, request, started, err as AppError);
    throw err;
  }
  const { evidence, match } = prepared;
  const deliberated = await deliberate(deps, prepared, request.options);
  const { output, approved, rounds, criticQueries, models, criticRan } = deliberated;
  const { finalOutput, guard, challenged } = await settle(deps, request, prepared, deliberated);

  const rationale = rationaleOf(finalOutput, guard);
  const criticVerdict = !criticRan ? "not_run" : approved ? "approved" : "escalated";
  const documentary = documentaryOf(match);
  const autonomy = autonomyOf(deps, evidence, output.decision, guard, criticVerdict);
  const record = buildDecisionRecord({
    autonomy,
    documentary,
    deps,
    runId: request.runId,
    alertId: request.alertId,
    evidence,
    decision: finalOutput,
    guard,
    rationale,
    criticQueries,
    models,
    criticRounds: rounds,
    criticVerdict,
    criticNotCitable: deliberated.notCitable,
  });
  const file = writeDecisionRecord(deps.config.logging.dir, record);
  trace.log({
    agent: "reporter",
    action: "seal_record",
    status: "ok",
    output_summary: `record ${record.record_id} sealed`,
    // Relative to the log folder: an absolute path would carry the machine's user name into the trace.
    detail: { record_hash: record.record_hash, file: relative(deps.config.logging.dir, file) },
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
    what_would_change: finalOutput.what_would_change,
    key_evidence: keyEvidence(match, guard),
    ...(evidence.hybrid ? { path: evidence.hybrid.path, first_finding: evidence.hybrid.decision } : {}),
    ...(autonomy ? { autonomy } : {}),
    ...(documentary ? { documentary } : {}),
    ...decisionSource(deliberated),
    ...(record.confidence_cap ? { confidence_cap: record.confidence_cap } : {}),
    citations,
    agents: challenged
      ? [...AGENT_ORDER.slice(0, CHALLENGER_AT), "challenger", ...AGENT_ORDER.slice(CHALLENGER_AT)]
      : AGENT_ORDER,
    models: record.models,
    guards: record.guards,
    critic: record.critic,
    record_id: record.record_id,
    record_hash: record.record_hash,
    human_review_required: autonomy?.outcome !== "auto_closed",
    approvals_required: guard.approvalsRequired,
    trace_id: request.runId,
    execution_time_seconds: (performance.now() - started) / 1000,
    ...(request.sampleMode ? { sample_mode: true, sample_notice: request.sampleNotice } : {}),
  });
}

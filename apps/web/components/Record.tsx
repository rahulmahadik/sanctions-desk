"use client";

import { useState } from "react";
import {
  checkVerdictWords,
  DECISION_ICON,
  DECISION_LABEL,
  DECISION_TONE,
  guardWords,
  label,
  percent,
  plainReason,
  shortHash,
  verdictWords,
} from "../lib/format";
import { agentLabel, graphAt, stepOf } from "../lib/graph";
import type { CloseStopView, RecordView, ReviewAnswer, RunEvent, TraceView } from "../lib/types";
import { RunGraph } from "./RunGraph";

function PathLine({ answer }: { answer: ReviewAnswer }) {
  if (!answer.path || !answer.decision) return null;
  const first = answer.first_finding;
  return (
    <p className="muted" data-testid="path">
      {answer.path === "confirm"
        ? `Path: the structured evidence settles it (code's first finding: ${DECISION_LABEL[first ?? answer.decision]}); the agents confirmed and explained it.`
        : `Path: the structured evidence did not settle it, or there is free text to weigh (code's first finding: ${first ? DECISION_LABEL[first] : "none"}); the agents reasoned over all of it.`}
    </p>
  );
}

function AutonomyNote({ answer }: { answer: ReviewAnswer }) {
  if (answer.autonomy?.outcome === "auto_closed") {
    return (
      <p className="banner" role="note" data-testid="auto-closed">
        {answer.autonomy.statement}. A person can reopen it from the decision panel.
      </p>
    );
  }
  if (answer.autonomy?.outcome === "qa_sample") {
    return (
      <p className="banner" role="note">
        This close met every condition for an automatic close and was picked for a quality-assurance review: a person
        decides it.
      </p>
    );
  }
  return null;
}

function ConfidenceLine({ answer }: { answer: ReviewAnswer }) {
  const cap = answer.confidence_cap;
  const auto = answer.autonomy?.outcome === "auto_closed";
  const approvals = answer.approvals_required ?? 1;
  const tail = auto
    ? "Closed under the autonomy setting."
    : approvals > 1
      ? `A person decides — this one needs ${approvals} approvals.`
      : "A person decides.";
  return (
    <p data-testid="confidence">
      Confidence {percent(answer.confidence ?? 0)}
      {cap ? ` (capped at ${percent(cap.value)}: ${cap.reason})` : ""}. {tail}
    </p>
  );
}

/**
 * The checks: every guard verdict (the screener's grounded and not-grounded signals, the documentary standard and the
 * rest), the critic's verdict, and any citation the critic set aside as not citable.
 */
function Checks({
  answer,
  alertType,
  closeStop,
}: {
  answer: ReviewAnswer;
  alertType?: string | null;
  closeStop?: CloseStopView | null;
}) {
  const rounds = answer.critic?.rounds;
  return (
    <>
      <h2>Checks</h2>
      <ul>
        {(answer.guards ?? []).map((g) => (
          <li key={`${g.guard}-${g.detail ?? ""}`} className={g.verdict === "pass" ? undefined : "tone-alert"}>
            {guardWords(g.guard)}: {checkVerdictWords(g.guard, g.verdict, closeStop)}
            {g.detail ? ` — ${plainReason(g.detail, alertType)}` : ""}
          </li>
        ))}
        {answer.critic ? (
          <li>
            critic: {verdictWords(answer.critic.final_verdict)} after {rounds} round{rounds === 1 ? "" : "s"}
          </li>
        ) : null}
        {(answer.critic?.not_citable ?? []).map((n) => (
          <li key={`not-citable-${n.table}-${n.column}-${n.round}`} className="tone-alert" data-testid="not-citable">
            critic set aside a citation of {n.table}.{n.column} as not citable (round {n.round}): {n.reason}
          </li>
        ))}
      </ul>
    </>
  );
}

const BulletList = ({ title, items, testId }: { title: string; items: readonly string[]; testId?: string }) =>
  items.length === 0 ? null : (
    <>
      <h2>{title}</h2>
      <ul data-testid={testId}>
        {items.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );

/**
 * The recommendation, why, and what would change it. A person acts on it. The alert type says whose name the
 * comparison is about: the payment counterparty's on a payment alert, the customer's otherwise.
 */
export function Outcome({
  answer,
  alertType,
  closeStop,
}: {
  answer: ReviewAnswer;
  alertType?: string | null;
  /** The run's close-stop reading, so a flag that stopped a close is not called a note that changed nothing. */
  closeStop?: CloseStopView | null;
}) {
  const plain = (lines: readonly string[] | undefined) => (lines ?? []).map((l) => plainReason(l, alertType));
  if (answer.status === "error" || !answer.decision) {
    return (
      <section className="panel" aria-labelledby="outcome-title" role="alert">
        <h2 id="outcome-title">No recommendation</h2>
        <p>{answer.error?.message ?? "The review did not finish."}</p>
        <p className="muted">The desk never invents a decision: a failed review is shown as a failure.</p>
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby="outcome-title">
      <h2 id="outcome-title">Recommendation</h2>
      <p className={`verdict tone-${DECISION_TONE[answer.decision]}`} data-testid="verdict">
        <span aria-hidden="true">{DECISION_ICON[answer.decision]} </span>
        {DECISION_LABEL[answer.decision]}
      </p>
      <PathLine answer={answer} />
      <AutonomyNote answer={answer} />
      <ConfidenceLine answer={answer} />
      <BulletList title="What decided it" items={plain(answer.key_evidence)} testId="key-evidence" />
      <p data-testid="rationale">{plainReason(answer.rationale ?? "", alertType)}</p>
      <BulletList title="What would change this" items={plain(answer.what_would_change)} />
      <Checks answer={answer} alertType={alertType} closeStop={closeStop} />
    </section>
  );
}

/** In sample mode every answer comes from the labelled rules stand-in, which is not a model. */
export function modelCallsText(trace: TraceView): string {
  const n = trace.cost.totals.local_calls + trace.cost.totals.cloud_calls;
  const models = trace.cost.models;
  const standIn = models.length > 0 && models.every((m) => m.model_routed === "fallback-rules");
  return standIn ? `${n} stand-in answer${n === 1 ? "" : "s"} (sample mode, no model)` : `${n} model calls`;
}

/** The four questions a reviewer or auditor asks, answered from the sealed record. */
export function FourQuestions({ trace }: { trace: TraceView }) {
  return (
    <section aria-labelledby="four-title" className="panel">
      <h2 id="four-title">Decision trace</h2>
      <dl className="facts">
        <dt>Which approved definition applied?</dt>
        <dd>{trace.definitions.map((d) => `${label(d.definition_id)} v${d.version}`).join(", ") || "none"}</dd>
        <dt>What data is it based on?</dt>
        <dd>
          Semantic layer {trace.data.usl.model_version}; list snapshots{" "}
          {trace.data.list_snapshots.map((s) => `${s.list} ${s.snapshot_id}`).join(", ") || "none"};{" "}
          {trace.data.queries.length} queries
        </dd>
        <dt>Who could see what?</dt>
        <dd>
          Policy version {trace.access.policy.version}.{" "}
          {trace.access.by_role
            .map(
              (r) =>
                `${r.role}: ${r.queries} queries (${r.token_source === "role" ? "own token" : "labelled fallback key"})${
                  r.masked_columns.length ? `, masked ${r.masked_columns.join(", ")}` : ""
                }`,
            )
            .join("; ")}
        </dd>
        <dt>What did it cost to produce?</dt>
        <dd>
          {modelCallsText(trace)}, {trace.cost.data_queries.count} data queries
        </dd>
        <dt>Record</dt>
        <dd>
          {shortHash(trace.record.hash)} —{" "}
          {trace.record.verified ? "verified: the hash matches the contents" : "does not verify"}
        </dd>
      </dl>
    </section>
  );
}

/**
 * Replay a finished run as of any point: drag the slider and the steps, the critic count and the event shown
 * are exactly what had been recorded up to that event. The sealed record's own as-of time is shown beside it.
 */
export function Replay({ events, record }: { events: RunEvent[]; record?: RecordView }) {
  const [at, setAt] = useState(events.length);
  const upTo = Math.min(at, events.length);
  const current = events[upTo - 1];
  const stepOfEvent = events.map((e) => stepOf(e.agent, e.action));
  const withEvents = new Set(stepOfEvent);
  /** A step's box moves the slider to that step's last recorded event. */
  const jumpToStep = (stepId: string) => {
    const last = stepOfEvent.lastIndexOf(stepId);
    if (last >= 0) setAt(last + 1);
  };
  return (
    <section aria-labelledby="replay-title">
      <h2 id="replay-title">Replay</h2>
      <p className="muted">
        {record
          ? `Recorded ${record.decided_at} against list snapshot ${record.list_snapshots.map((x) => x.snapshot_id).join(", ") || "none"} (policy version ${record.policy.version}). The slider steps through the events of this run as they were recorded; it does not re-run the case on an earlier list.`
          : "Move through the recorded events of this run."}
      </p>
      <label htmlFor="replay-range">
        Event {upTo} of {events.length}
      </label>
      <input
        id="replay-range"
        className="range"
        type="range"
        min={0}
        max={events.length}
        value={upTo}
        onChange={(e) => setAt(Number(e.target.value))}
      />
      <p className="muted">Click a step or an event to jump to it.</p>
      <RunGraph view={graphAt(events, upTo)} onSelect={jumpToStep} selectable={withEvents} />
      <p aria-live="polite" data-testid="replay-current">
        {current
          ? `${agentLabel(current.agent, current.action)} · ${label(current.action)} · ${current.output_summary ?? current.status}`
          : "Before the run started"}
      </p>
      <ol className="events" aria-label="Recorded events">
        {events.map((e, i) => (
          <li key={e.seq} aria-current={i === upTo - 1 ? "true" : undefined}>
            <button type="button" className="event-jump" onClick={() => setAt(i + 1)}>
              {String(e.seq).padStart(2, "0")} {stepOf(e.agent, e.action)}/{e.action} [{e.status}]{" "}
              {e.output_summary ?? ""}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

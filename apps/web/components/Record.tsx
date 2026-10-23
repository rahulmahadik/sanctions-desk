"use client";

import { useState } from "react";
import { DECISION_LABEL, DECISION_TONE, label, percent, shortHash } from "../lib/format";
import { graphAt } from "../lib/graph";
import type { RecordView, ReviewAnswer, RunEvent, TraceView } from "../lib/types";
import { RunGraph } from "./RunGraph";

/** The recommendation, why, and what would change it. A person acts on it. */
export function Outcome({ answer }: { answer: ReviewAnswer }) {
  if (answer.status === "error" || !answer.decision) {
    return (
      <section className="panel" aria-labelledby="outcome-title" role="alert">
        <h2 id="outcome-title">No recommendation</h2>
        <p>{answer.error?.message ?? "The review did not finish."}</p>
        <p className="muted">The desk never invents a decision: a failed review is shown as a failure.</p>
      </section>
    );
  }
  const tone = DECISION_TONE[answer.decision];
  const cap = answer.confidence_cap;
  const evidence = answer.key_evidence ?? [];
  return (
    <section className="panel" aria-labelledby="outcome-title">
      <h2 id="outcome-title">Recommendation</h2>
      <p className={`verdict tone-${tone}`} data-testid="verdict">
        {DECISION_LABEL[answer.decision]}
      </p>
      {answer.path ? (
        <p className="muted" data-testid="path">
          {answer.path === "confirm"
            ? `Path: the structured evidence settles it (code's first finding: ${DECISION_LABEL[answer.first_finding ?? answer.decision]}); the agents confirmed and explained it.`
            : `Path: the structured evidence did not settle it, or there is free text to weigh (code's first finding: ${answer.first_finding ? DECISION_LABEL[answer.first_finding] : "none"}); the agents reasoned over all of it.`}
        </p>
      ) : null}
      {answer.autonomy?.outcome === "auto_closed" ? (
        <p className="banner" role="note" data-testid="auto-closed">
          {answer.autonomy.statement}. A person can reopen it from the decision panel.
        </p>
      ) : answer.autonomy?.outcome === "qa_sample" ? (
        <p className="banner" role="note">
          This close met every condition for an automatic close and was picked for a quality-assurance review: a person
          decides it.
        </p>
      ) : null}
      <p data-testid="confidence">
        Confidence {percent(answer.confidence ?? 0)}
        {cap ? ` (capped at ${percent(cap.value)}: ${cap.reason})` : ""}.{" "}
        {answer.autonomy?.outcome === "auto_closed" ? "Closed under the autonomy setting." : "A person decides"}
        {answer.autonomy?.outcome !== "auto_closed" && answer.approvals_required && answer.approvals_required > 1
          ? ` — this one needs ${answer.approvals_required} approvals.`
          : answer.autonomy?.outcome === "auto_closed"
            ? ""
            : "."}
      </p>
      {evidence.length > 0 ? (
        <>
          <h2>What decided it</h2>
          <ul data-testid="key-evidence">
            {evidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p>{answer.rationale}</p>
      {answer.what_would_change.length > 0 ? (
        <>
          <h2>What would change this</h2>
          <ul>
            {answer.what_would_change.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h2>Checks</h2>
      <ul>
        {(answer.guards ?? []).map((g) => (
          <li key={`${g.guard}-${g.detail ?? ""}`} className={g.verdict === "pass" ? undefined : "tone-alert"}>
            {label(g.guard)}: {g.verdict}
            {g.detail ? ` — ${g.detail}` : ""}
          </li>
        ))}
        {answer.critic ? (
          <li>
            critic: {answer.critic.final_verdict} after {answer.critic.rounds} round
            {answer.critic.rounds === 1 ? "" : "s"}
          </li>
        ) : null}
      </ul>
    </section>
  );
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
          {trace.cost.totals.local_calls + trace.cost.totals.cloud_calls} model calls, {trace.cost.data_queries.count}{" "}
          data queries
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
  return (
    <section aria-labelledby="replay-title">
      <h2 id="replay-title">Replay</h2>
      <p className="muted">
        {record
          ? `Recorded ${record.decided_at}, using data and policy as of ${record.as_of} (policy version ${record.policy.version}).`
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
      <RunGraph view={graphAt(events, upTo)} />
      <p aria-live="polite" data-testid="replay-current">
        {current
          ? `${label(current.agent)} · ${label(current.action)} · ${current.output_summary ?? current.status}`
          : "Before the run started"}
      </p>
      <ol className="events" aria-label="Recorded events">
        {events.map((e, i) => (
          <li key={e.seq} aria-current={i === upTo - 1 ? "true" : undefined}>
            {String(e.seq).padStart(2, "0")} {e.agent}/{e.action} [{e.status}] {e.output_summary ?? ""}
          </li>
        ))}
      </ol>
    </section>
  );
}

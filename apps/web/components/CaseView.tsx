"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchEvents, fetchEvidence, fetchRecord, fetchTrace, followRun, startReview } from "../lib/api";
import { graphAt } from "../lib/graph";
import type { EvidenceView, RecordView, ReviewAnswer, RunEvent, TraceView } from "../lib/types";
import { HumanBanner } from "./Banner";
import { EvidenceCards } from "./Evidence";
import { FourQuestions, Outcome, Replay } from "./Record";
import { RoutingPanel } from "./Routing";
import { RunGraph } from "./RunGraph";

type Phase = "ready" | "running" | "finished";

/** One case: start a review, watch it happen, then read the evidence, routing, trace and replay. */
export function CaseView({ alertId }: { alertId: string }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [answer, setAnswer] = useState<ReviewAnswer>();
  const [evidence, setEvidence] = useState<EvidenceView>();
  const [trace, setTrace] = useState<TraceView>();
  const [record, setRecord] = useState<RecordView>();
  const [problem, setProblem] = useState<string>();
  const stop = useRef<() => void>(() => undefined);

  const loadDetails = useCallback(async () => {
    const [e, t, r] = await Promise.allSettled([fetchEvidence(alertId), fetchTrace(alertId), fetchRecord(alertId)]);
    if (e.status === "fulfilled") setEvidence(e.value);
    if (t.status === "fulfilled") setTrace(t.value);
    if (r.status === "fulfilled") setRecord(r.value);
    if (e.status === "rejected") setProblem(e.reason instanceof Error ? e.reason.message : String(e.reason));
  }, [alertId]);

  // The facts can be read before any review: they come from the evidence role, masked.
  useEffect(() => {
    void loadDetails();
    return () => stop.current();
  }, [loadDetails]);

  const review = async () => {
    const runId = `ui-${alertId}-${Date.now()}`;
    setPhase("running");
    setProblem(undefined);
    setAnswer(undefined);
    setEvents([]);
    stop.current = followRun(
      runId,
      (event) => setEvents((previous) => [...previous, event]),
      () => undefined,
    );
    try {
      const result = await startReview(alertId, runId);
      setAnswer(result);
      // The stream may have closed before the last events arrived; the recorded history is the source of truth.
      const history = await fetchEvents(runId).catch(() => undefined);
      if (history) setEvents(history.events);
      await loadDetails();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      stop.current();
      setPhase("finished");
    }
  };

  const view = graphAt(events);
  return (
    <>
      <HumanBanner sampleMode={answer?.sample_mode} notice={answer?.sample_notice} />
      <p>
        <button type="button" onClick={review} disabled={phase === "running"}>
          {phase === "running" ? "Reviewing…" : phase === "finished" ? "Review again" : "Review this alert"}
        </button>{" "}
        <span className="muted">Alert {alertId}</span>
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {phase === "running" ? "Review in progress" : phase === "finished" ? "Review finished" : ""}
      </p>
      {problem ? (
        <p className="panel tone-stop" role="alert">
          {problem}
        </p>
      ) : null}
      {answer ? <Outcome answer={answer} /> : null}
      {phase !== "ready" ? <RunGraph view={view} /> : null}
      {trace ? <FourQuestions trace={trace} /> : null}
      {evidence ? <EvidenceCards view={evidence} /> : null}
      {trace ? <RoutingPanel trace={trace} /> : null}
      {phase === "finished" && events.length > 0 ? <Replay events={events} record={record} /> : null}
    </>
  );
}

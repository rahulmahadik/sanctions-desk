"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchEvents,
  fetchEvidence,
  fetchExam,
  fetchPolicy,
  fetchRecord,
  fetchTrace,
  followRun,
  startReview,
} from "../lib/api";
import { graphAt } from "../lib/graph";
import type { EvidenceView, RecordView, ReviewAnswer, RoutingSplit, RunEvent, TraceView } from "../lib/types";
import { HumanBanner } from "./Banner";
import { CaseBanner } from "./CaseBanner";
import { DecisionPanel } from "./DecisionPanel";
import { EvidenceCards } from "./Evidence";
import { FourQuestions, Outcome, Replay } from "./Record";
import { RoutingPanel } from "./Routing";
import { RunGraph, stoppedSteps } from "./RunGraph";
import { SignalsPanel, type SignalThresholds } from "./Signals";

type Phase = "ready" | "running" | "finished";
const BUTTON: Record<Phase, string> = { ready: "Review this alert", running: "Reviewing…", finished: "Review again" };
const STATUS: Record<Phase, string> = { ready: "", running: "Review in progress", finished: "Review finished" };

/** The active policy's screener thresholds, or nothing when the policy cannot be read. */
async function loadThresholds(): Promise<SignalThresholds | undefined> {
  const { policy } = await fetchPolicy().catch(() => ({ policy: {} as Record<string, unknown> }));
  const s = policy.screener as { confidenceThreshold?: unknown; otherConfidenceThreshold?: unknown } | undefined;
  return typeof s?.confidenceThreshold === "number" && typeof s.otherConfidenceThreshold === "number"
    ? { normal: s.confidenceThreshold, other: s.otherConfidenceThreshold }
    : undefined;
}

/** One case: start a review, watch it happen, then read the evidence, routing, trace and replay. */
export function CaseView({ alertId }: { alertId: string }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [answer, setAnswer] = useState<ReviewAnswer>();
  const [evidence, setEvidence] = useState<EvidenceView>();
  const [trace, setTrace] = useState<TraceView>();
  const [record, setRecord] = useState<RecordView>();
  const [split, setSplit] = useState<RoutingSplit | null>();
  const [thresholds, setThresholds] = useState<SignalThresholds>();
  const [problem, setProblem] = useState<string>();
  const [facts, setFacts] = useState<"reading" | "read">("reading");
  const stop = useRef<() => void>(() => undefined);

  const loadDetails = useCallback(async () => {
    const [e, t, r] = await Promise.allSettled([fetchEvidence(alertId), fetchTrace(alertId), fetchRecord(alertId)]);
    if (e.status === "fulfilled") setEvidence(e.value);
    if (t.status === "fulfilled") setTrace(t.value);
    if (r.status === "fulfilled") setRecord(r.value);
    // Before a review there is no trace and no record yet (404); every other failure is said plainly.
    const expected = (x: PromiseSettledResult<unknown>) =>
      x.status === "rejected" && x.reason instanceof ApiError && x.reason.status === 404;
    const problems = [e, ...[t, r].filter((x) => !expected(x))].flatMap((x) =>
      x.status === "rejected" ? [x.reason instanceof Error ? x.reason.message : String(x.reason)] : [],
    );
    if (problems.length > 0) setProblem([...new Set(problems)].join("; "));
    setFacts("read");
  }, [alertId]);

  // The facts can be read before any review: they come from the evidence role, masked.
  useEffect(() => {
    void loadDetails();
    // The measured split from the latest full exam is context for the routing panel; the case does not depend on it.
    fetchExam()
      .then((exam) => setSplit(exam.routing_split ?? null))
      .catch(() => setSplit(null));
    // The screener's thresholds say which signals block a close; without them the panel still shows every signal.
    void loadThresholds().then(setThresholds);
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
      <CaseBanner
        decision={answer?.decision ?? record?.decision}
        rationale={answer?.rationale ?? record?.rationale}
        closeStop={trace?.close_stop}
      />
      <p>
        <button type="button" onClick={review} disabled={phase === "running"}>
          {BUTTON[phase]}
        </button>{" "}
        <span className="muted">Alert {alertId}</span>
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {STATUS[phase]}
      </p>
      {facts === "reading" && !problem ? <p className="muted">Reading the case facts…</p> : null}
      {problem ? (
        <p className="panel tone-stop" role="alert">
          {problem}
        </p>
      ) : null}
      {answer ? <Outcome answer={answer} /> : null}
      <DecisionPanel alertId={alertId} refreshKey={answer?.run_id ?? record?.record_hash} />
      {phase !== "ready" ? <RunGraph view={view} stopped={stoppedSteps(trace?.close_stop)} /> : null}
      {trace ? <FourQuestions trace={trace} /> : null}
      {record?.screener ? (
        <SignalsPanel screener={record.screener} evidence={evidence} thresholds={thresholds} />
      ) : null}
      {evidence ? <EvidenceCards view={evidence} documentary={record?.documentary} /> : null}
      {trace ? <RoutingPanel trace={trace} split={split} /> : null}
      {phase === "finished" && events.length > 0 ? <Replay events={events} record={record} /> : null}
    </>
  );
}

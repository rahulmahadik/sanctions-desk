"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchQueue } from "../lib/api";
import { DECISION_LABEL, modelName, type ReadProblem, readProblem, shortHash } from "../lib/format";
import { SESSION_EVENT } from "../lib/session";
import type { QueueAlert, Severity } from "../lib/types";
import { BlockedByChips, OutcomeBadge, SeverityBadge } from "./Badges";
import { HumanBanner, ProblemNote } from "./Banner";
import { ListChangePanel } from "./ListChange";

type Filter = "all" | "open" | "reviewed";

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Most severe first; the queue read carries no raise time, so alerts of equal severity keep their id order. */
export function bySeverity(a: QueueAlert, b: QueueAlert): number {
  const d = SEVERITY_ORDER[a.severity ?? "low"] - SEVERITY_ORDER[b.severity ?? "low"];
  return d !== 0 ? d : a.alert_id.localeCompare(b.alert_id);
}

type ModelUse = { model: string; route: string; calls: number };

/**
 * Four counts across the top of the queue, every one counted from the alerts and records the API returned. "Open" is
 * the alert's own status in the screening system (the bank's alert table), not whether the desk has reviewed it.
 */
export function SummaryStrip({ alerts, models }: { alerts: readonly QueueAlert[]; models: readonly ModelUse[] }) {
  const open = alerts.filter((a) => a.status === "open").length;
  const others = Object.entries(
    alerts
      .filter((a) => a.status !== "open")
      .reduce<Record<string, number>>((m, a) => {
        m[a.status] = (m[a.status] ?? 0) + 1;
        return m;
      }, {}),
  )
    .map(([status, n]) => `${n} ${status.replaceAll("_", " ")}`)
    .join(", ");
  const waiting = alerts.filter(
    (a) =>
      a.recommendation &&
      (a.human_status === "awaiting" || a.human_status === "block_pending" || a.human_status === "override_pending"),
  ).length;
  const blocked = alerts.filter((a) => (a.blocked_by ?? []).length > 0).length;
  const calls = models.reduce((n, m) => n + m.calls, 0);
  return (
    <section className="summary-strip" aria-label="Queue summary" data-testid="summary-strip">
      <div className="stat">
        <strong>
          {open} of {alerts.length}
        </strong>
        alerts open in the screening system{others ? ` (${others} there)` : ""}
      </div>
      <div className="stat">
        <strong>{waiting}</strong>recommendations waiting for a person
      </div>
      <div className="stat">
        <strong>{blocked}</strong>closes stopped by a check
      </div>
      <div className="stat">
        <strong>{models.length === 0 ? "none yet" : `${calls} calls`}</strong>
        {models.length === 0
          ? "no model has served a recommendation"
          : models.map((m) => `${modelName(m.model)} (${m.route}) ${m.calls}`).join(" · ")}
      </div>
    </section>
  );
}

const Pill = ({ tone, icon, text }: { tone: string; icon: string; text: string }) => (
  <span className="pill" data-tone={tone}>
    <span className="icon" aria-hidden="true">
      {icon}
    </span>
    {text}
  </span>
);

/** Where people have taken the recommendation: auto-closed, a quality-assurance sample, human-approved, or waiting. */
function PersonBadge({ alert: a }: { alert: QueueAlert }) {
  if (a.autonomy_outcome === "auto_closed" && a.human_status === "auto_closed")
    return <Pill tone="pending" icon="◷" text="auto-closed" />;
  if (a.autonomy_outcome === "qa_sample" && a.human_status === "awaiting")
    return <Pill tone="escalate" icon="◆" text="QA sample: a person decides" />;
  if (a.human_status && a.human_status !== "awaiting") {
    const text =
      a.human_status === "block_pending"
        ? "block approval pending"
        : a.human_status === "override_pending"
          ? "close override pending"
          : a.human_final
            ? `human-approved: ${DECISION_LABEL[a.human_final]}`
            : "human-approved";
    return <Pill tone="close" icon="✓" text={text} />;
  }
  return a.recommendation ? <Pill tone="pending" icon="○" text="waiting for a person" /> : null;
}

export function Queue() {
  const [alerts, setAlerts] = useState<QueueAlert[]>();
  const [sampleMode, setSampleMode] = useState(false);
  const [models, setModels] = useState<ModelUse[]>([]);
  const [threshold, setThreshold] = useState<number>();
  const [problem, setProblem] = useState<ReadProblem>();
  const [filter, setFilter] = useState<Filter>("all");
  const [type, setType] = useState("all");

  useEffect(() => {
    const load = () =>
      fetchQueue()
        .then((q) => {
          setAlerts(q.alerts);
          setSampleMode(q.sample_mode);
          setModels(q.models_used ?? []);
          setThreshold(q.name_threshold);
          setProblem(undefined);
        })
        .catch((err: unknown) => setProblem(readProblem(err, "the alert queue")));
    void load();
    // Signing in (or out) reads the queue again.
    window.addEventListener(SESSION_EVENT, load);
    return () => window.removeEventListener(SESSION_EVENT, load);
  }, []);

  const shown = useMemo(
    () =>
      (alerts ?? [])
        .filter(
          (a) =>
            (filter === "all" || (filter === "reviewed" ? a.recommendation !== null : a.recommendation === null)) &&
            (type === "all" || a.alert_type === type),
        )
        .sort(bySeverity),
    [alerts, filter, type],
  );

  if (problem) return <ProblemNote problem={problem} lead="The queue could not be read" />;
  if (!alerts) return <p role="status">Reading the alert queue…</p>;

  return (
    <>
      <HumanBanner sampleMode={sampleMode} />
      <SummaryStrip alerts={alerts} models={models} />
      <ListChangePanel />
      <div className="panel">
        <label>
          Show{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">all alerts</option>
            <option value="open">not yet reviewed</option>
            <option value="reviewed">reviewed</option>
          </select>
        </label>{" "}
        <label>
          Type{" "}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">all</option>
            <option value="customer">customer</option>
            <option value="payment">payment</option>
          </select>
        </label>{" "}
        <span className="muted">
          {shown.length} of {alerts.length} alerts, most severe first (severity is the strength of the name match)
        </span>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Alerts waiting for review</caption>
            <thead>
              <tr>
                <th>Alert</th>
                <th>Severity</th>
                <th>Type</th>
                <th>Matched name</th>
                <th title="The name score the screening system gave when it raised the alert; the review compares the names again">
                  Alert score
                </th>
                <th>Recommendation</th>
                <th>Person</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.alert_id}>
                  <td className="nowrap">
                    <Link href={`/case/${encodeURIComponent(a.alert_id)}`}>{a.alert_id}</Link>
                  </td>
                  <td>{a.severity ? <SeverityBadge severity={a.severity} threshold={threshold} /> : "—"}</td>
                  <td title={`raised by ${a.alert_source.replaceAll("_", " ")}`}>{a.alert_type}</td>
                  <td>{a.matched_name}</td>
                  <td>{a.match_score.toFixed(2)}</td>
                  <td>
                    <OutcomeBadge decision={a.recommendation} />
                    {a.recommendation ? <span className="sr-only">{DECISION_LABEL[a.recommendation]}</span> : null}
                    {(a.blocked_by ?? []).length > 0 ? (
                      <div style={{ marginTop: 4 }}>
                        <BlockedByChips by={a.blocked_by} />
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <PersonBadge alert={a} />
                  </td>
                  <td className="muted nowrap">{shortHash(a.record_hash)}</td>
                </tr>
              ))}
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted" role="status">
                    {alerts.length === 0
                      ? "The queue is empty: there are no alerts to review."
                      : "No alerts match this filter."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

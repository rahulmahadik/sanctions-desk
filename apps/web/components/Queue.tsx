"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchQueue } from "../lib/api";
import { DECISION_LABEL, DECISION_TONE, shortHash } from "../lib/format";
import type { QueueAlert } from "../lib/types";
import { HumanBanner } from "./Banner";

type Filter = "all" | "open" | "reviewed";

function RecommendationBadge({ alert: a }: { alert: QueueAlert }) {
  if (!a.recommendation) return <span className="muted">not yet reviewed</span>;
  return <span className={`badge tone-${DECISION_TONE[a.recommendation]}`}>{DECISION_LABEL[a.recommendation]}</span>;
}

/** Where people have taken the recommendation: auto-closed, a quality-assurance sample, human-approved, or waiting. */
function PersonBadge({ alert: a }: { alert: QueueAlert }) {
  if (a.autonomy_outcome === "auto_closed" && a.human_status === "auto_closed")
    return <span className="badge tone-wait">auto-closed</span>;
  if (a.autonomy_outcome === "qa_sample" && a.human_status === "awaiting")
    return <span className="badge tone-alert">QA sample: a person decides</span>;
  if (a.human_status && a.human_status !== "awaiting") {
    const text =
      a.human_status === "block_pending"
        ? "block approval pending"
        : a.human_final
          ? `human-approved: ${DECISION_LABEL[a.human_final]}`
          : "human-approved";
    return <span className="badge tone-calm">{text}</span>;
  }
  return a.recommendation ? <span className="muted">waiting for a person</span> : null;
}

export function Queue() {
  const [alerts, setAlerts] = useState<QueueAlert[]>();
  const [sampleMode, setSampleMode] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [type, setType] = useState("all");

  useEffect(() => {
    fetchQueue()
      .then((q) => {
        setAlerts(q.alerts);
        setSampleMode(q.sample_mode);
      })
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
  }, []);

  const shown = useMemo(
    () =>
      (alerts ?? []).filter(
        (a) =>
          (filter === "all" || (filter === "reviewed" ? a.recommendation !== null : a.recommendation === null)) &&
          (type === "all" || a.alert_type === type),
      ),
    [alerts, filter, type],
  );

  if (problem) {
    return (
      <p className="panel tone-stop" role="alert">
        The queue could not be read: {problem}
      </p>
    );
  }
  if (!alerts) return <p role="status">Reading the alert queue…</p>;

  return (
    <>
      <HumanBanner sampleMode={sampleMode} />
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
          {shown.length} of {alerts.length} alerts
        </span>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Alerts waiting for review</caption>
            <thead>
              <tr>
                <th>Alert</th>
                <th>Type</th>
                <th>Raised by</th>
                <th>Matched name</th>
                <th>Score</th>
                <th>Recommendation</th>
                <th>Person</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.alert_id}>
                  <td>
                    <Link href={`/case/${encodeURIComponent(a.alert_id)}`}>{a.alert_id}</Link>
                  </td>
                  <td>{a.alert_type}</td>
                  <td>{a.alert_source.replaceAll("_", " ")}</td>
                  <td>{a.matched_name}</td>
                  <td>{a.match_score.toFixed(2)}</td>
                  <td>
                    <RecommendationBadge alert={a} />
                  </td>
                  <td>
                    <PersonBadge alert={a} />
                  </td>
                  <td className="muted">{shortHash(a.record_hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

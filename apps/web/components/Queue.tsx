"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchQueue } from "../lib/api";
import { DECISION_LABEL, DECISION_TONE, shortHash } from "../lib/format";
import type { QueueAlert } from "../lib/types";
import { HumanBanner } from "./Banner";

type Filter = "all" | "open" | "reviewed";

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
                    {a.recommendation ? (
                      <span className={`badge tone-${DECISION_TONE[a.recommendation]}`}>
                        {DECISION_LABEL[a.recommendation]}
                      </span>
                    ) : (
                      <span className="muted">not yet reviewed</span>
                    )}
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

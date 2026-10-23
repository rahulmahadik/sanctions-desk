"use client";

import { useEffect, useState } from "react";
import { fetchExam } from "../lib/api";
import { money, percent } from "../lib/format";
import type { ExamAnswer, ExamResult } from "../lib/types";

const VARIANT_NOTE: Record<string, string> = {
  routed: "Full system: local and cloud Nemotron through Nightshift, critic and memory",
  single: "One recommendation: no critic, no memory",
  local: "Fast mode only, no reasoning budget",
  rules: "Rules stand-in, no language model",
  no_memory: "Full system without memory",
  fuzzy: "Baseline: name-score threshold only",
  escalate_all: "Baseline: escalate everything",
};

function latest(results: ExamResult[]): ExamResult[] {
  // Results come newest first, so the first one seen for a variant is its latest.
  const byVariant = new Map<string, ExamResult>();
  for (const r of results) if (!byVariant.has(r.variant)) byVariant.set(r.variant, r);
  return [...byVariant.values()];
}

/** Results of the exam, straight from the files the exam runner saved. Nothing is typed in by hand. */
export function ExamDashboard() {
  const [exam, setExam] = useState<ExamAnswer>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    fetchExam()
      .then(setExam)
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
  }, []);

  if (problem) {
    return (
      <p className="panel tone-stop" role="alert">
        The exam results could not be read: {problem}
      </p>
    );
  }
  if (!exam) return <p role="status">Reading the exam results…</p>;
  const rows = latest(exam.results);
  const groups = rows[0] ? Object.keys(rows[0].metrics.by_group) : [];

  if (rows.length === 0) {
    return (
      <p className="panel">
        The exam has {exam.cases} cases, but no results have been saved yet. Run{" "}
        <code>npm run exam -- --variant routed</code>.
      </p>
    );
  }

  return (
    <>
      <p className="muted">
        {exam.cases} cases. Each variant is from one run; model answers vary between runs and the runtime may answer
        repeated prompts from its cache, which affects time and cost.
      </p>
      <div className="panel table-wrap">
        <table>
          <caption>Variants compared</caption>
          <thead>
            <tr>
              <th>Variant</th>
              <th>Exact</th>
              <th>Acceptable</th>
              <th>False closes</th>
              <th>Errors</th>
              <th>Median time</th>
              <th>Cloud share</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.file}>
                <td>
                  <strong>{r.variant}</strong>
                  <div className="muted">{VARIANT_NOTE[r.variant] ?? ""}</div>
                </td>
                <td>{percent(r.metrics.exact_accuracy)}</td>
                <td>{percent(r.metrics.acceptable_accuracy)}</td>
                <td className={r.metrics.false_closes === 0 ? "tone-calm" : "tone-stop"}>
                  {r.metrics.false_closes} of {r.metrics.risk_cases} risk cases
                </td>
                <td>{r.metrics.errors}</td>
                <td>{r.metrics.latency_s.p50.toFixed(1)} s</td>
                <td>{percent(r.metrics.model_calls.cloud_share)}</td>
                <td>{money(r.metrics.cost.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel table-wrap">
        <table>
          <caption>Acceptable answers by case group</caption>
          <thead>
            <tr>
              <th>Group</th>
              {rows.map((r) => (
                <th key={r.file}>{r.variant}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g}>
                <td>{g.replaceAll("_", " ")}</td>
                {rows.map((r) => {
                  const m = r.metrics.by_group[g];
                  return (
                    <td key={r.file}>
                      {m ? `${m.acceptable}/${m.cases}` : "—"}
                      <div className="bar" aria-hidden="true">
                        <span style={{ width: `${m ? (m.acceptable / m.cases) * 100 : 0}%` }} />
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { postListChange } from "../lib/api";
import { DECISION_LABEL, label } from "../lib/format";
import type { ListChangeCaseView, ListChangeView } from "../lib/types";

function CaseRow({ c }: { c: ListChangeCaseView }) {
  return (
    <tr>
      <td>{c.disposition_id}</td>
      <td>
        {c.entry_name ?? c.entry_id} <span className="muted">({c.entry_id})</span>
      </td>
      <td>{DECISION_LABEL[c.earlier_decision]}</td>
      <td>
        <code>{c.earlier_snapshot_id ?? "not recorded"}</code>
      </td>
      <td>
        <code>{c.current_snapshot_id ?? "removed from the list"}</code>
      </td>
      <td>{label(c.reason_code)}</td>
      <td>
        {c.open_alert_ids.length === 0 ? (
          <span className="muted">none open</span>
        ) : (
          c.open_alert_ids.map((id) => (
            <span key={id}>
              <Link href={`/case/${encodeURIComponent(id)}`}>{id}</Link>{" "}
            </span>
          ))
        )}
      </td>
    </tr>
  );
}

/**
 * Checks every earlier decision against the listed entry as it is now. A changed entry is offered for re-review, a
 * removed one for release by a person. Nothing is reopened or released here.
 */
export function ListChangePanel() {
  const [report, setReport] = useState<ListChangeView>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      setReport(await postListChange());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const rows = report ? [...report.reopen, ...report.release] : [];
  return (
    <section className="panel" aria-labelledby="list-change-title">
      <h2 id="list-change-title">List change</h2>
      <p>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run()}>
          {busy ? "Checking…" : "Check earlier decisions against the list as it is now"}
        </button>
      </p>
      {problem ? (
        <p role="alert" className="tone-stop">
          {problem}
        </p>
      ) : null}
      {report ? (
        <>
          <p data-testid="list-change-summary">
            {report.examined} earlier decisions checked: {report.reopen.length} to review again because the listed entry
            changed, {report.release.length} for a person to consider releasing because the entry was removed,{" "}
            {report.unchanged} unchanged. This {report.impact.summary}. Nothing has been reopened or released.
          </p>
          {rows.length > 0 ? (
            <div className="table-wrap">
              <table data-testid="list-change">
                <caption className="sr-only">Earlier decisions whose listed entry changed or was removed</caption>
                <thead>
                  <tr>
                    <th>Earlier decision</th>
                    <th>Listed party</th>
                    <th>Outcome then</th>
                    <th>List snapshot then</th>
                    <th>List snapshot now</th>
                    <th>Why</th>
                    <th>Open alerts to review</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <CaseRow key={c.disposition_id} c={c} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

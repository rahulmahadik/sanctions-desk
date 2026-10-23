"use client";

import { useEffect, useState } from "react";
import { fetchGovernance } from "../lib/api";
import { label, percent } from "../lib/format";
import type { GovernanceView } from "../lib/types";
import { SplitTable } from "./Routing";

/** The governance page: what the desk is, how risky it is, how it is overseen, tested, watched and changed. */
export function Governance() {
  const [view, setView] = useState<GovernanceView>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    fetchGovernance()
      .then(setView)
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
  }, []);

  if (problem) {
    return (
      <p className="panel tone-stop" role="alert">
        The governance page could not be read: {problem}
      </p>
    );
  }
  if (!view) return <p role="status">Reading the governance view…</p>;
  const {
    inventory,
    risk_materiality: risk,
    human_oversight: oversight,
    testing,
    monitoring,
    change_control: change,
  } = view;
  const h = testing.headline;

  return (
    <>
      <p className="banner" role="note" data-testid="mapping-note">
        {view.mapping_note}
      </p>

      <section className="panel" aria-labelledby="g-inventory">
        <h2 id="g-inventory">AI inventory entry</h2>
        <dl className="facts">
          <dt>Name</dt>
          <dd>{inventory.name}</dd>
          <dt>Purpose</dt>
          <dd>{inventory.purpose}</dd>
          <dt>Status</dt>
          <dd>{inventory.status}</dd>
          <dt>Deployment</dt>
          <dd>{inventory.deployment}</dd>
          <dt>Data</dt>
          <dd>{inventory.data}</dd>
          <dt>Models</dt>
          <dd>
            {inventory.models.map((m) => (
              <div key={m.name}>
                {m.name}, {m.served}; used by {m.used_by.join(", ")}
              </div>
            ))}
            <div className="muted">{inventory.which_model_serves}</div>
          </dd>
          <dt>Built on</dt>
          <dd>{inventory.components.join("; ")}</dd>
          <dt>Policy version</dt>
          <dd>{inventory.policy_version}</dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="g-risk">
        <h2 id="g-risk">Risk materiality</h2>
        <p className="muted">{risk.kind}</p>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Risk materiality dimensions</caption>
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Rating</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {risk.dimensions.map((d) => (
                <tr key={d.dimension}>
                  <td>{d.dimension}</td>
                  <td>{d.rating}</td>
                  <td>{d.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>{risk.conclusion}</p>
      </section>

      <section className="panel" aria-labelledby="g-oversight">
        <h2 id="g-oversight">Human oversight</h2>
        <dl className="facts">
          {Object.entries(oversight.hard_limits).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{label(k)}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
        <ul>
          {oversight.controls.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="g-explain">
        <h2 id="g-explain">Explainability</h2>
        <p>{view.explainability.record}</p>
        <p>{view.explainability.evidence}</p>
        <p className="muted">Where to look: {view.explainability.where.join("; ")}</p>
      </section>

      <section className="panel" aria-labelledby="g-testing">
        <h2 id="g-testing">Testing</h2>
        {h && testing.headline_sentence ? (
          <p data-testid="governance-headline">
            Latest full exam of the full system: {testing.headline_sentence} False closes on cases that carry real risk:{" "}
            {h.false_closes} of {h.risk_cases} ({percent(h.false_close_rate)}).
          </p>
        ) : (
          <p>No complete exam run is saved yet.</p>
        )}
        <p>
          {testing.baselines}. Full results: <code>{testing.exam_report}</code>. {testing.limits}.
        </p>
        {testing.label_changes.length > 0 ? (
          <p className="muted">
            Labels changed after the first full run: {testing.label_changes.map((c) => c.case_id).join(", ")} (reasons
            in the report).
          </p>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="g-monitoring">
        <h2 id="g-monitoring">Monitoring</h2>
        <p>{monitoring.model_ledger}.</p>
        <p>{monitoring.provider_failures}.</p>
        <p>{monitoring.access}.</p>
        {monitoring.routing_split ? (
          <SplitTable split={monitoring.routing_split} />
        ) : (
          <p className="muted">No routing split measured yet.</p>
        )}
        {monitoring.json_failure_rate ? <p className="muted">{monitoring.json_failure_rate.note}</p> : null}
      </section>

      <section className="panel" aria-labelledby="g-change">
        <h2 id="g-change">Change control</h2>
        <p>{change.rule}</p>
        <p>
          Active policy version {change.active_policy_version}; {change.audit_entries} audit entries. {change.code}.
        </p>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Policy versions</caption>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Proposed by</th>
                <th>Approved by</th>
              </tr>
            </thead>
            <tbody>
              {change.policy_versions.map((v) => (
                <tr key={v.version}>
                  <td>{v.version}</td>
                  <td>{v.status}</td>
                  <td>{v.proposed_by}</td>
                  <td>{v.approved_by ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="g-limits">
        <h2 id="g-limits">Limits</h2>
        <ul>
          {view.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

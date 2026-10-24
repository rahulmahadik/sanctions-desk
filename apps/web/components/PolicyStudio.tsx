"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  fetchAutoClosed,
  fetchAutonomy,
  fetchMe,
  fetchPolicy,
  fetchPolicyAudit,
  fetchPolicyVersions,
  postDiscard,
  postKillSwitch,
  postPolicyDraft,
  postPublish,
  postWhatIf,
} from "../lib/api";
import { REASON_LENGTH } from "../lib/format";
import { SESSION_EVENT } from "../lib/session";
import type {
  AutoClosedItem,
  AutonomyView,
  MeView,
  PolicyAuditEntry,
  PolicyVersionRow,
  WhatIfView,
} from "../lib/types";

const MIN_QA = 0.05;
const MIN_REASON = REASON_LENGTH.min;

/** The autonomy card: how much a person does, what is locked, today's closes against the cap, the kill switch. */
function AutonomyCard({ view, me, onChange }: { view: AutonomyView; me?: MeView; onChange: () => void }) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string>();
  const killed = view.kill_switch.active;
  const canStop = me?.user.role === "approver" || me?.user.role === "policy_admin";
  const canRestore = me?.user.role === "policy_admin";
  const ok = reason.trim().length >= MIN_REASON;

  const toggle = async (active: boolean) => {
    setProblem(undefined);
    try {
      await postKillSwitch(active, reason.trim());
      setReason("");
      onChange();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="panel" aria-labelledby="autonomy-h" data-testid="autonomy-card">
      <h2 id="autonomy-h">Autonomy</h2>
      <p>
        Level in force:{" "}
        <span className={`badge ${view.level_in_force === 1 ? "tone-alert" : "tone-calm"}`}>
          {view.level_in_force === 1
            ? "level 1: certain closes are closed without waiting"
            : "level 0: a person approves every alert"}
        </span>{" "}
        <span className="muted">
          Policy version {view.policy_version} asks for level {view.policy_level}.
        </span>
      </p>
      {killed ? (
        <p className="banner tone-stop" role="alert">
          Kill switch is on since {view.kill_switch.at}, set by {view.kill_switch.by}: {view.kill_switch.reason}
        </p>
      ) : null}
      <p>
        Today ({view.today.day}): <strong>{view.today.auto_closed}</strong> closed automatically of a cap of{" "}
        {view.today.cap}; <strong>{view.today.qa_sample}</strong> picked for quality assurance; {view.today.reopened}{" "}
        reopened.
      </p>
      <p className="muted">
        At level 1 a close is automatic only when code, the decision agent, the critic and the challenger all agree, the
        evidence standard is met, no data-quality rule fails and the confidence is at least{" "}
        {Math.round(view.settings.autoClose.confidenceAtLeast * 100)}%.{" "}
        {Math.round(view.settings.autoClose.qaSampleRate * 100)}% of those go to a person at random.
      </p>
      <h3>Locked: no setting changes these</h3>
      <ul>
        {view.locked.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p>
        <label>
          Reason{" "}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ minWidth: 280 }}
            maxLength={REASON_LENGTH.max}
          />
        </label>{" "}
        {killed ? (
          <button type="button" disabled={!canRestore || !ok} onClick={() => void toggle(false)}>
            Switch autonomy back on
          </button>
        ) : (
          <button type="button" className="secondary" disabled={!canStop || !ok} onClick={() => void toggle(true)}>
            Kill switch: force level 0 now
          </button>
        )}{" "}
        {!canStop ? (
          <span className="muted">
            An approver or policy admin can stop autonomy; only a policy admin can switch it back on.
          </span>
        ) : null}
      </p>
      {problem ? (
        <p role="alert" className="tone-stop">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

function ChangeAutonomy({ view, me, onDone }: { view: AutonomyView; me?: MeView; onDone: () => void }) {
  const [level, setLevel] = useState<0 | 1>(view.settings.level);
  const [line, setLine] = useState(String(Math.round(view.settings.autoClose.confidenceAtLeast * 100)));
  const [rate, setRate] = useState(String(Math.round(view.settings.autoClose.qaSampleRate * 100)));
  const [cap, setCap] = useState(String(view.settings.autoClose.dailyCap));
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<number>();

  const rateNum = Number(rate) / 100;
  const tooLow = rateNum < MIN_QA;
  const blocked = !me?.permissions.propose_policy
    ? "Only an approver or a policy admin can propose a policy change."
    : tooLow
      ? "The quality-assurance sample must be at least 5%."
      : reason.trim().length < MIN_REASON
        ? `Give a reason of at least ${MIN_REASON} characters.`
        : undefined;

  const propose = async () => {
    setProblem(undefined);
    try {
      const { policy } = await fetchPolicy();
      const draft = await postPolicyDraft(
        {
          ...policy,
          autonomy: {
            ...(policy.autonomy as Record<string, unknown>),
            level,
            autoClose: { confidenceAtLeast: Number(line) / 100, qaSampleRate: rateNum, dailyCap: Number(cap) },
          },
        },
        reason.trim(),
      );
      setDone(draft.version);
      onDone();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="panel" aria-labelledby="change-h">
      <h2 id="change-h">Change autonomy</h2>
      <p className="muted">
        A change is a draft. Preview what it would do on the exam, then a different policy admin publishes it. Nothing
        changes until then.
      </p>
      <fieldset>
        <legend>Level</legend>
        <label>
          <input type="radio" name="level" checked={level === 0} onChange={() => setLevel(0)} /> 0: a person approves
          every alert
        </label>{" "}
        <label>
          <input type="radio" name="level" checked={level === 1} onChange={() => setLevel(1)} /> 1: certain closes are
          closed automatically
        </label>
      </fieldset>
      <p>
        <label>
          Confidence at least (%){" "}
          <input type="number" min={70} max={100} value={line} onChange={(e) => setLine(e.target.value)} />
        </label>{" "}
        <label>
          Quality-assurance sample (%, at least 5){" "}
          <input type="number" min={5} max={100} value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>{" "}
        <label>
          Daily cap <input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Reason{" "}
          <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 320 }} maxLength={500} />
        </label>
      </p>
      <button type="button" disabled={blocked !== undefined} onClick={() => void propose()}>
        Create a draft
      </button>{" "}
      {blocked ? <span className="muted">{blocked}</span> : null}
      {done ? <p role="status">Draft version {done} created. Preview it below.</p> : null}
      {problem ? (
        <p role="alert" className="tone-stop">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** What the exam replay of a draft found, with the autonomy counts when the draft is at level 1. */
function WhatIfResult({ version, report }: { version: number; report: WhatIfView }) {
  const a = report.autonomy;
  return (
    <div data-testid={`whatif-${version}`}>
      <p>
        {report.cases} exam cases replayed: {report.changed} would change, {report.less_cautious} less cautious,{" "}
        <strong className={report.new_false_closes > 0 ? "tone-stop" : "tone-calm"}>
          {report.new_false_closes} new false closes
        </strong>
        .
      </p>
      {a ? (
        <p data-testid="whatif-autonomy">
          At level 1: <strong>{a.auto_closed}</strong> would be closed automatically, <strong>{a.qa_sample}</strong>{" "}
          sampled for quality assurance ({Math.round(a.qa_rate * 100)}%), {a.human_review} left to a person. False
          closes on the exam:{" "}
          <strong className={a.false_closes > 0 ? "tone-stop" : "tone-calm"}>{a.false_closes}</strong> (must be 0)
          {a.false_closes > 0 ? ". Do not publish this draft." : "."}
        </p>
      ) : (
        <p className="muted">This draft stays at level 0.</p>
      )}
    </div>
  );
}

const publishBlocker = (me: MeView | undefined, draft: PolicyVersionRow): string | undefined => {
  if (!me?.permissions.publish_policy) return "Only a policy admin can publish.";
  return me.user.id === draft.proposed_by
    ? "You wrote this draft; a different policy admin must publish it."
    : undefined;
};

interface DraftActions {
  preview: (version: number) => Promise<void>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}

function DraftCard({
  draft: d,
  me,
  report,
  actions,
}: {
  draft: PolicyVersionRow;
  me?: MeView;
  report?: WhatIfView | "running";
  actions: DraftActions;
}) {
  const blocked = publishBlocker(me, d);
  return (
    <article aria-label={`Draft ${d.version}`}>
      <h3>
        Version {d.version} <span className="muted">proposed by {d.proposed_by}</span>
      </h3>
      {d.reason ? <p className="muted">{d.reason}</p> : null}
      <button
        type="button"
        className="secondary"
        disabled={report === "running"}
        onClick={() => void actions.preview(d.version)}
      >
        {report === "running" ? "Replaying the exam…" : "Preview on the exam"}
      </button>{" "}
      <button
        type="button"
        disabled={blocked !== undefined}
        onClick={() => void actions.act(() => postPublish(d.version))}
      >
        Publish
      </button>{" "}
      <button type="button" className="secondary" onClick={() => void actions.act(() => postDiscard(d.version))}>
        Discard
      </button>{" "}
      {blocked ? <span className="muted">{blocked}</span> : null}
      {report && report !== "running" ? <WhatIfResult version={d.version} report={report} /> : null}
    </article>
  );
}

function Drafts({ versions, me, onChange }: { versions: PolicyVersionRow[]; me?: MeView; onChange: () => void }) {
  const [views, setViews] = useState<Record<number, WhatIfView | "running">>({});
  const [problem, setProblem] = useState<string>();
  const drafts = versions.filter((v) => v.status === "draft");
  if (drafts.length === 0) return null;

  const fail = (err: unknown) => setProblem(err instanceof Error ? err.message : String(err));
  const preview = async (version: number) => {
    setViews((v) => ({ ...v, [version]: "running" }));
    try {
      const report = await postWhatIf(version);
      setViews((v) => ({ ...v, [version]: report }));
    } catch (err) {
      setViews((v) => {
        const { [version]: _gone, ...rest } = v;
        return rest;
      });
      fail(err);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setProblem(undefined);
    try {
      await fn();
      onChange();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <section className="panel" aria-labelledby="drafts-h">
      <h2 id="drafts-h">Drafts</h2>
      {drafts.map((d) => (
        <DraftCard key={d.version} draft={d} me={me} report={views[d.version]} actions={{ preview, act }} />
      ))}
      {problem ? (
        <p role="alert" className="tone-stop">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

function AutoClosedList({ items, me, onChange }: { items: AutoClosedItem[]; me?: MeView; onChange: () => void }) {
  return (
    <section className="panel" aria-labelledby="auto-h">
      <h2 id="auto-h">Closed automatically: for review</h2>
      {items.length === 0 ? (
        <p className="muted">Nothing has been closed automatically.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Automatic closes</caption>
            <thead>
              <tr>
                <th>Alert</th>
                <th>When</th>
                <th>Policy</th>
                <th>Statement</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.alert_id}>
                  <td>
                    <Link href={`/case/${encodeURIComponent(i.alert_id)}`}>{i.alert_id}</Link>
                  </td>
                  <td>{new Date(i.decided_at).toLocaleString()}</td>
                  <td>v{i.policy_version}</td>
                  <td>{i.statement}</td>
                  <td>
                    {i.status === "auto_closed" ? (
                      <span className="badge tone-wait">auto-closed</span>
                    ) : (
                      <span className="badge tone-alert">reopened by {i.reopened_by}</span>
                    )}
                    {i.status === "auto_closed" && me?.permissions.decide ? (
                      <>
                        {" "}
                        <Link href={`/case/${encodeURIComponent(i.alert_id)}`} onClick={onChange}>
                          review or reopen
                        </Link>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Policy Studio: autonomy, drafts with an exam preview, the people who changed what, and what was closed on its own. */
export function PolicyStudio() {
  const [me, setMe] = useState<MeView>();
  const [view, setView] = useState<AutonomyView>();
  const [versions, setVersions] = useState<PolicyVersionRow[]>([]);
  const [audit, setAudit] = useState<PolicyAuditEntry[]>([]);
  const [items, setItems] = useState<AutoClosedItem[]>([]);
  const [problem, setProblem] = useState<string>();

  const load = useCallback(() => {
    Promise.all([fetchMe(), fetchAutonomy(), fetchPolicyVersions(), fetchPolicyAudit(), fetchAutoClosed()])
      .then(([m, a, v, au, ac]) => {
        setMe(m);
        setView(a);
        setVersions(v.versions);
        setAudit(au.entries);
        setItems(ac.items);
        setProblem(undefined);
      })
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SESSION_EVENT, load);
    return () => window.removeEventListener(SESSION_EVENT, load);
  }, [load]);

  if (problem)
    return (
      <p className="panel tone-stop" role="alert">
        Policy Studio could not load: {problem}
      </p>
    );
  if (!view) return <p role="status">Reading the policy…</p>;

  return (
    <>
      <AutonomyCard view={view} me={me} onChange={load} />
      <ChangeAutonomy view={view} me={me} onDone={load} />
      <Drafts versions={versions} me={me} onChange={load} />
      <AutoClosedList items={items} me={me} onChange={load} />
      <section className="panel" aria-labelledby="versions-h">
        <h2 id="versions-h">Versions and changes</h2>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Policy versions</caption>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Proposed by</th>
                <th>Published by</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td>{v.version}</td>
                  <td>{v.status}</td>
                  <td>{v.proposed_by}</td>
                  <td>{v.approved_by ?? "—"}</td>
                  <td>{v.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Audit log</h3>
        <ol className="events" aria-label="Policy audit log">
          {audit.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: audit entries have no id
            <li key={i}>
              {a.ts} {a.actor} {a.action.replaceAll("_", " ")} version {a.version}
              {a.detail ? `: ${a.detail}` : ""}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

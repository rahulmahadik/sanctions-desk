"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  downloadCaseFile,
  fetchHuman,
  fetchMe,
  postDecision,
  postReopen,
  postSecondApproval,
} from "../lib/api";
import { DECISION_ICON, DECISION_LABEL, DECISION_TONE, REASON_LENGTH, roleLabel, shortHash } from "../lib/format";
import { SESSION_EVENT } from "../lib/session";
import type { ActionCheck, ActionRecordView, Decision, HumanActionView, HumanView, MeView } from "../lib/types";

const OUTCOMES: Decision[] = ["CLOSE_FALSE_POSITIVE", "NEED_MORE_INFO", "ESCALATE_L2", "RECOMMEND_BLOCK"];
const CAUTION: Record<Decision, number> = {
  CLOSE_FALSE_POSITIVE: 0,
  NEED_MORE_INFO: 1,
  ESCALATE_L2: 2,
  RECOMMEND_BLOCK: 3,
};
const MIN_REASON = REASON_LENGTH.min;

const KIND_LABEL: Record<ActionRecordView["body"]["kind"], string> = {
  closure_note: "Closure note",
  escalation_ticket: "Escalation ticket",
  rfi_draft: "Request for information (draft)",
  hold_instruction: "Hold instruction (draft)",
  block_recommendation: "Block recommendation for the sanctions officer",
};
const CHECK_LABEL: Record<ActionCheck, string> = {
  signed_and_pinned: "signed (Ed25519), key matches the configured public key",
  signed_unpinned: "signed (Ed25519), key not pinned",
  hash_sealed: "hash-sealed (no signing key configured)",
  invalid: "does not verify",
};
const STATUS_LABEL: Record<HumanView["status"], string> = {
  awaiting: "Waiting for a person to decide",
  auto_closed: "Closed automatically under the autonomy setting; a person can reopen it",
  decided: "Decided by a person",
  block_pending: "Block approval pending: a second, different approver must confirm",
  block_approved: "Block recommendation approved by two people",
  block_declined: "Block declined by the second approver; escalated",
  override_pending: "Override to a close pending: a second, different approver must confirm",
  override_approved: "Override to a close approved by two people",
  override_declined: "Override to a close declined by the second approver; escalated",
};

const ACTION_TEXT: Record<HumanActionView["action"], string> = {
  approve: "approved",
  override: "overrode to",
  second_approval: "gave the second approval for",
  reopen: "reopened the automatic close",
  reject: "declined the block, so",
};

const needsReason = `Give a reason of at least ${MIN_REASON} characters.`;

/** Why a decision cannot be sent yet, in words, or undefined when it can. */
export function decideBlocker(
  me: MeView | undefined,
  rec: Decision,
  action: "approve" | "override",
  outcome: Decision,
  reasonOk: boolean,
): string | undefined {
  if (!me || me.user.role === "viewer") return "Choose a demo user (or sign in) to record a decision.";
  if (!me.permissions.decide) return `The ${roleLabel(me.user.role)} role cannot record decisions.`;
  if (action === "override" && CAUTION[outcome] < CAUTION[rec] && !me.permissions.override_towards_less_caution)
    return "Only an approver can override towards a less cautious outcome.";
  if (action === "override" && outcome === rec) return "An override must choose a different outcome.";
  return reasonOk ? undefined : needsReason;
}

export function secondBlocker(me: MeView | undefined, firstActor: string | undefined, reasonOk: boolean) {
  if (!me) return "Choose a demo user.";
  if (!me.permissions.approve_block) return "The second approval must come from an approver.";
  if (me.user.id === firstActor) return "You made the first decision; a different approver must confirm.";
  return reasonOk ? undefined : needsReason;
}

export function reopenBlocker(me: MeView | undefined, reasonOk: boolean) {
  if (!me?.permissions.decide) return "Choose a demo user who can decide (analyst or approver), or sign in.";
  return reasonOk ? undefined : needsReason;
}

interface Shared {
  alertId: string;
  view: HumanView;
  me?: MeView;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  submit: (fn: () => Promise<HumanView>) => Promise<void>;
}

const ReasonBox = ({
  label,
  rows,
  ...p
}: {
  label: string;
  rows: number;
  reason: string;
  setReason: (v: string) => void;
}) => (
  <p>
    <label>
      {label}{" "}
      <textarea
        rows={rows}
        value={p.reason}
        maxLength={REASON_LENGTH.max}
        onChange={(e) => p.setReason(e.target.value)}
        style={{ width: "100%" }}
      />
    </label>
  </p>
);

function ActionsTaken({ view }: { view: HumanView }) {
  if (view.actions_taken.length === 0) return null;
  return (
    <ol className="events" aria-label="What people did">
      {view.actions_taken.map((a) => (
        <li key={`${a.actor}-${a.at}`}>
          <strong>{a.actor}</strong> {a.role ? <span className="badge tone-wait">{roleLabel(a.role)}</span> : null}{" "}
          {ACTION_TEXT[a.action]} {a.outcome ? DECISION_LABEL[a.outcome] : ""}: <em>{a.reason}</em>{" "}
          <span className="muted">{new Date(a.at).toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}

function ReopenForm({ alertId, view, me, reason, setReason, busy, submit }: Shared) {
  const blocked = reopenBlocker(me, reason.trim().length >= MIN_REASON);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) void submit(() => postReopen(alertId, { reason: reason.trim(), record_hash: view.record_hash }));
      }}
    >
      <p data-testid="auto-closed-statement">{view.autonomy?.statement}.</p>
      <ReasonBox label="Reason for reopening" rows={2} reason={reason} setReason={setReason} />
      <button type="submit" disabled={busy || blocked !== undefined}>
        Reopen this close
      </button>{" "}
      {blocked ? <span className="muted">{blocked}</span> : null}
    </form>
  );
}

function DecideForm({ alertId, view, me, reason, setReason, busy, submit }: Shared) {
  const [action, setAction] = useState<"approve" | "override">("approve");
  const [outcome, setOutcome] = useState<Decision>("ESCALATE_L2");
  const rec = view.recommendation.decision;
  const blocked = decideBlocker(me, rec, action, outcome, reason.trim().length >= MIN_REASON);
  const chosen = action === "approve" ? rec : outcome;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        void submit(() =>
          postDecision(alertId, {
            action,
            ...(action === "override" ? { outcome } : {}),
            reason: reason.trim(),
            record_hash: view.record_hash,
          }),
        );
      }}
    >
      <fieldset>
        <legend>Your decision</legend>
        <label>
          <input type="radio" name="action" checked={action === "approve"} onChange={() => setAction("approve")} />{" "}
          Approve the recommendation
        </label>{" "}
        <label>
          <input type="radio" name="action" checked={action === "override"} onChange={() => setAction("override")} />{" "}
          Override with
        </label>{" "}
        <select
          aria-label="Outcome for an override"
          value={outcome}
          disabled={action !== "override"}
          onChange={(e) => setOutcome(e.target.value as Decision)}
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {DECISION_LABEL[o]}
            </option>
          ))}
        </select>
      </fieldset>
      <ReasonBox label="Reason (required, shown in the record)" rows={3} reason={reason} setReason={setReason} />
      <p id="decision-hint" className="muted">
        {chosen === "RECOMMEND_BLOCK"
          ? "A block is not final: it waits for a second, different approver, and even then it is only a recommendation for the sanctions officer."
          : "Nothing is sent or executed. Approving prepares the next record below; you can read it before anyone acts on it."}
      </p>
      <button type="submit" disabled={busy || blocked !== undefined}>
        {busy ? "Saving…" : action === "approve" ? "Approve" : "Override"}
      </button>{" "}
      {blocked ? <span className="muted">{blocked}</span> : null}
    </form>
  );
}

function SecondForm({ alertId, view, me, reason, setReason, busy, submit }: Shared) {
  const blocked = secondBlocker(me, view.actions_taken[0]?.actor, reason.trim().length >= MIN_REASON);
  const send = (approve: boolean) =>
    submit(() => postSecondApproval(alertId, { approve, reason: reason.trim(), record_hash: view.record_hash }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) void send(true);
      }}
    >
      <ReasonBox label="Reason for the second approval" rows={2} reason={reason} setReason={setReason} />
      <button type="submit" disabled={busy || blocked !== undefined}>
        Give the second approval
      </button>{" "}
      <button
        type="button"
        className="secondary"
        disabled={busy || blocked !== undefined}
        onClick={() => void send(false)}
      >
        {view.status === "override_pending" ? "Decline the close" : "Decline the block"}
      </button>{" "}
      {blocked ? <span className="muted">{blocked}</span> : null}
    </form>
  );
}

function NextActions({ view }: { view: HumanView }) {
  if (view.next_actions.length === 0) return <p className="muted">Nothing is prepared until a person has decided.</p>;
  return (
    <ul className="plain">
      {view.next_actions.map((a) => (
        <li key={a.action_id}>
          <strong>{KIND_LABEL[a.body.kind]}</strong> <span className="badge tone-wait">{a.body.status}</span>{" "}
          <span className="muted">not sent; {CHECK_LABEL[a.check]}</span>
          <pre className="note">{a.body.content}</pre>
        </li>
      ))}
    </ul>
  );
}

/** Loads the case's decision state and who is signed in, and reloads when either changes. */
function useDecisionState(alertId: string, refreshKey: unknown) {
  const [me, setMe] = useState<MeView>();
  const [view, setView] = useState<HumanView>();
  const [problem, setProblem] = useState<string>();
  const load = useCallback(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(undefined));
    fetchHuman(alertId)
      .then((v) => {
        setView(v);
        setProblem(undefined);
      })
      .catch((err: unknown) => {
        setView(undefined);
        setProblem(err instanceof ApiError && err.status === 404 ? undefined : (err as Error).message);
      });
  }, [alertId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a reload after a new review
  useEffect(() => {
    load();
    window.addEventListener(SESSION_EVENT, load);
    return () => window.removeEventListener(SESSION_EVENT, load);
  }, [load, refreshKey]);
  return { me, view, setView, problem, setProblem };
}

/** The step where a person decides. The desk recommends; nothing happens until someone approves or overrides. */
export function DecisionPanel({ alertId, refreshKey }: { alertId: string; refreshKey?: unknown }) {
  const { me, view, setView, problem, setProblem } = useDecisionState(alertId, refreshKey);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (!view) {
    return (
      <section className="panel" aria-labelledby="decision-h">
        <h2 id="decision-h">Decision</h2>
        {problem ? (
          <p role="alert" className="tone-stop">
            {problem}
          </p>
        ) : (
          <p className="muted">There is no recommendation yet. Review the alert first; then a person decides here.</p>
        )}
      </section>
    );
  }

  const run = async (fn: () => Promise<unknown>, after?: (v: HumanView) => void) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const value = await fn();
      if (after) after(value as HumanView);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (fn: () => Promise<HumanView>) =>
    run(fn, (v) => {
      setView(v);
      setReason("");
    });
  const shared: Shared = { alertId, view, me, reason, setReason, busy, submit };
  const rec = view.recommendation.decision;

  return (
    <section className="panel" aria-labelledby="decision-h">
      <h2 id="decision-h">Decision</h2>
      <p>
        The desk recommends{" "}
        <span className="pill" data-tone={DECISION_TONE[rec]}>
          <span className="icon" aria-hidden="true">
            {DECISION_ICON[rec]}
          </span>
          {DECISION_LABEL[rec]}
        </span>{" "}
        <span className="muted">(record {shortHash(view.record_hash)})</span>. {STATUS_LABEL[view.status]}.
      </p>
      {problem ? (
        <p role="alert" className="tone-stop">
          {problem}
        </p>
      ) : null}
      {view.autonomy?.outcome === "qa_sample" && view.status === "awaiting" ? (
        <p className="banner" role="note">
          Picked for a quality-assurance review: this close met every condition for an automatic close, and a person
          decides it.
        </p>
      ) : null}
      {view.status === "auto_closed" ? <ReopenForm {...shared} /> : null}
      <ActionsTaken view={view} />
      {view.status === "awaiting" ? <DecideForm {...shared} /> : null}
      {view.status === "block_pending" || view.status === "override_pending" ? <SecondForm {...shared} /> : null}
      <p>
        {(["pdf", "md"] as const).map((format) => (
          <span key={format}>
            <button
              type="button"
              className="secondary"
              onClick={() => void run(() => downloadCaseFile(alertId, format))}
            >
              Download case file ({format === "pdf" ? "PDF" : "Markdown"})
            </button>{" "}
          </span>
        ))}
      </p>
      <h3>Case file: what happens next</h3>
      <NextActions view={view} />
    </section>
  );
}

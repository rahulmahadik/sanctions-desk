"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  ApiError,
  downloadCaseFile,
  fetchHuman,
  fetchMe,
  postDecision,
  postReopen,
  postSecondApproval,
} from "../lib/api";
import {
  DECISION_ICON,
  DECISION_LABEL,
  DECISION_TONE,
  plainReason,
  REASON_LENGTH,
  roleLabel,
  shortHash,
} from "../lib/format";
import { type Action, actionProblem, refusal, type Who, whoFromError } from "../lib/permissions";
import { SESSION_EVENT } from "../lib/session";
import type { ActionCheck, ActionRecordView, Decision, HumanActionView, HumanView } from "../lib/types";

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
export const STATUS_LABEL: Record<HumanView["status"], string> = {
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

const ACTION_TEXT: Record<Exclude<HumanActionView["action"], "reject">, string> = {
  approve: "approved",
  override: "overrode to",
  second_approval: "gave the second approval for",
  reopen: "reopened the automatic close",
};

/**
 * What one person did, in words. A decline is stored as "reject" for both a block and an override to a close, so the
 * case's status says which one was declined.
 */
export function actionText(action: HumanActionView["action"], status: HumanView["status"]): string {
  if (action !== "reject") return ACTION_TEXT[action];
  return status === "override_declined" ? "declined the close, so" : "declined the block, so";
}

const needsReason = `Give a reason of at least ${MIN_REASON} characters.`;

/** Why a decision cannot be sent yet, in words, or undefined when it can. */
export function decideBlocker(
  who: Who,
  rec: Decision,
  action: "approve" | "override" | undefined,
  outcome: Decision,
  reasonOk: boolean,
): string | undefined {
  const refused = refusal(who, "decide");
  if (refused) return refused;
  // Nothing is chosen for the person: they pick approve or override themselves.
  if (action === undefined) return "Choose approve or override.";
  if (action === "override" && CAUTION[outcome] < CAUTION[rec]) {
    const lessCautious = refusal(who, "overrideLessCautious");
    if (lessCautious) return lessCautious;
  }
  if (action === "override" && outcome === rec) return "An override must choose a different outcome.";
  return reasonOk ? undefined : needsReason;
}

/**
 * The record the panel is about. Each decision re-seals the record with the decision added (a new record whose
 * previous_record_hash is the one before), so the hash changes; the panel says so instead of showing a new hash bare.
 */
export function recordLine(view: Pick<HumanView, "record_hash" | "previous_record_hash">): string {
  return view.previous_record_hash
    ? `(record ${shortHash(view.record_hash)}, which adds the decision to ${shortHash(view.previous_record_hash)})`
    : `(record ${shortHash(view.record_hash)})`;
}

export function secondBlocker(who: Who, firstActor: string | undefined, reasonOk: boolean) {
  return refusal(who, "secondApproval", { firstActor }) ?? (reasonOk ? undefined : needsReason);
}

export function reopenBlocker(who: Who, reasonOk: boolean) {
  return refusal(who, "reopen") ?? (reasonOk ? undefined : needsReason);
}

/** The person whose decision waits for the second approval: the first approve or override, as the server reads it. */
const firstDecider = (view: HumanView): string | undefined =>
  view.actions_taken.find((a) => a.action === "approve" || a.action === "override")?.actor;

interface Shared {
  alertId: string;
  view: HumanView;
  who: Who;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  submit: (action: Action, fn: () => Promise<HumanView>) => Promise<void>;
}

/** The reason a form's buttons cannot be pressed, linked to them by id. */
const Blocked = ({ id, text }: { id: string; text: string | undefined }) =>
  text ? (
    <span id={id} className="muted">
      {text}
    </span>
  ) : null;

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
          {actionText(a.action, view.status)} {a.outcome ? DECISION_LABEL[a.outcome] : ""}: <em>{a.reason}</em>{" "}
          <span className="muted">{new Date(a.at).toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}

function ReopenForm({ alertId, view, who, reason, setReason, busy, submit }: Shared) {
  const blocked = reopenBlocker(who, reason.trim().length >= MIN_REASON);
  const why = useId();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked)
          void submit("reopen", () => postReopen(alertId, { reason: reason.trim(), record_hash: view.record_hash }));
      }}
    >
      <p data-testid="auto-closed-statement">{view.autonomy?.statement}.</p>
      <ReasonBox label="Reason for reopening" rows={2} reason={reason} setReason={setReason} />
      <button type="submit" disabled={busy || blocked !== undefined} aria-describedby={blocked ? why : undefined}>
        Reopen this close
      </button>{" "}
      <Blocked id={why} text={blocked} />
    </form>
  );
}

function DecideForm({ alertId, view, who, reason, setReason, busy, submit }: Shared) {
  const [action, setAction] = useState<"approve" | "override">();
  const [outcome, setOutcome] = useState<Decision>("ESCALATE_L2");
  const why = useId();
  const rec = view.recommendation.decision;
  const blocked = decideBlocker(who, rec, action, outcome, reason.trim().length >= MIN_REASON);
  const chosen = action === "approve" ? rec : action === "override" ? outcome : undefined;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked || action === undefined) return;
        const lessCautious = action === "override" && CAUTION[outcome] < CAUTION[rec];
        void submit(lessCautious ? "overrideLessCautious" : "decide", () =>
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
          : chosen === "CLOSE_FALSE_POSITIVE" && action === "override"
            ? "An override to a close is not final: it waits for a second, different approver. Nothing is sent or executed."
            : "Nothing is sent or executed. Deciding prepares the next record below; you can read it before anyone acts on it."}
      </p>
      <button type="submit" disabled={busy || blocked !== undefined} aria-describedby={blocked ? why : undefined}>
        {busy ? "Saving…" : action === "override" ? "Override" : action === "approve" ? "Approve" : "Decide"}
      </button>{" "}
      <Blocked id={why} text={blocked} />
    </form>
  );
}

function SecondForm({ alertId, view, who, reason, setReason, busy, submit }: Shared) {
  const blocked = secondBlocker(who, firstDecider(view), reason.trim().length >= MIN_REASON);
  const why = useId();
  const described = blocked ? why : undefined;
  const send = (approve: boolean) =>
    submit("secondApproval", () =>
      postSecondApproval(alertId, { approve, reason: reason.trim(), record_hash: view.record_hash }),
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) void send(true);
      }}
    >
      <ReasonBox label="Reason for the second approval" rows={2} reason={reason} setReason={setReason} />
      <button type="submit" disabled={busy || blocked !== undefined} aria-describedby={described}>
        Give the second approval
      </button>{" "}
      <button
        type="button"
        className="secondary"
        disabled={busy || blocked !== undefined}
        aria-describedby={described}
        onClick={() => void send(false)}
      >
        {view.status === "override_pending" ? "Decline the close" : "Decline the block"}
      </button>{" "}
      <Blocked id={why} text={blocked} />
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
          {/* Older sealed notes hold raw codes; show them in words. */}
          <pre className="note">{plainReason(a.body.content, a.body.alert_type)}</pre>
        </li>
      ))}
    </ul>
  );
}

/** Loads the case's decision state and who is signed in, and reloads when either changes. */
function useDecisionState(alertId: string, refreshKey: unknown) {
  const [who, setWho] = useState<Who>();
  const [view, setView] = useState<HumanView>();
  const [problem, setProblem] = useState<string>();
  const load = useCallback(() => {
    fetchMe()
      .then(setWho)
      .catch((err: unknown) => setWho(whoFromError(err)));
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
  return { who, view, setView, problem, setProblem };
}

/** The step where a person decides. The desk recommends; nothing happens until someone approves or overrides. */
export function DecisionPanel({ alertId, refreshKey }: { alertId: string; refreshKey?: unknown }) {
  const { who, view, setView, problem, setProblem } = useDecisionState(alertId, refreshKey);
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

  const run = async (fn: () => Promise<unknown>, action?: Action, after?: (v: HumanView) => void) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const value = await fn();
      if (after) after(value as HumanView);
    } catch (err) {
      // A refusal for the role is said in plain words; any other failure as the server said it.
      setProblem(action ? actionProblem(err, action) : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (action: Action, fn: () => Promise<HumanView>) =>
    run(fn, action, (v) => {
      setView(v);
      setReason("");
    });
  const shared: Shared = { alertId, view, who, reason, setReason, busy, submit };
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
        <span className="muted" data-testid="record-line">
          {recordLine(view)}
        </span>
        . {STATUS_LABEL[view.status]}.
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

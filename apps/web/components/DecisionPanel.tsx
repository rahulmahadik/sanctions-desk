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
import { DECISION_LABEL, DECISION_TONE, shortHash } from "../lib/format";
import { SESSION_EVENT } from "../lib/session";
import type { ActionCheck, ActionRecordView, Decision, HumanView, MeView } from "../lib/types";

const OUTCOMES: Decision[] = ["CLOSE_FALSE_POSITIVE", "NEED_MORE_INFO", "ESCALATE_L2", "RECOMMEND_BLOCK"];
const CAUTION: Record<Decision, number> = {
  CLOSE_FALSE_POSITIVE: 0,
  NEED_MORE_INFO: 1,
  ESCALATE_L2: 2,
  RECOMMEND_BLOCK: 3,
};
const MIN_REASON = 10;

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
};

/** The step where a person decides. The desk recommends; nothing happens until someone approves or overrides. */
export function DecisionPanel({ alertId, refreshKey }: { alertId: string; refreshKey?: unknown }) {
  const [me, setMe] = useState<MeView>();
  const [view, setView] = useState<HumanView>();
  const [problem, setProblem] = useState<string>();
  const [action, setAction] = useState<"approve" | "override">("approve");
  const [outcome, setOutcome] = useState<Decision>("ESCALATE_L2");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

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

  const rec = view.recommendation.decision;
  const chosen = action === "approve" ? rec : outcome;
  const lessCautious = action === "override" && CAUTION[outcome] < CAUTION[rec];
  const reasonOk = reason.trim().length >= MIN_REASON;
  const canDecide = me?.permissions.decide === true;
  const blockedBy =
    !me || me.user.role === "viewer"
      ? "Choose a demo user (or sign in) to record a decision."
      : !canDecide
        ? `A ${me.user.role.replace("_", " ")} cannot record decisions.`
        : lessCautious && !me.permissions.override_towards_less_caution
          ? "Only an approver can override towards a less cautious outcome."
          : action === "override" && outcome === rec
            ? "An override must choose a different outcome."
            : !reasonOk
              ? `Give a reason of at least ${MIN_REASON} characters.`
              : undefined;

  const submit = async (fn: () => Promise<HumanView>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      setView(await fn());
      setReason("");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reopenBlocked = !canDecide
    ? "Choose a demo user who can decide (analyst or approver), or sign in."
    : !reasonOk
      ? `Give a reason of at least ${MIN_REASON} characters.`
      : undefined;
  const download = async (format: "pdf" | "md") => {
    setProblem(undefined);
    try {
      await downloadCaseFile(alertId, format);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };
  const first = view.actions_taken[0];
  const waitingForSecond = view.status === "block_pending";
  const secondBlocked = !me
    ? "Choose a demo user."
    : !me.permissions.approve_block
      ? "The second approval must come from an approver."
      : me.user.id === first?.actor
        ? "You made the first decision; a different approver must confirm."
        : !reasonOk
          ? `Give a reason of at least ${MIN_REASON} characters.`
          : undefined;

  return (
    <section className="panel" aria-labelledby="decision-h">
      <h2 id="decision-h">Decision</h2>
      <p>
        The desk recommends <span className={`badge tone-${DECISION_TONE[rec]}`}>{DECISION_LABEL[rec]}</span>{" "}
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

      {view.status === "auto_closed" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!reopenBlocked)
              void submit(() => postReopen(alertId, { reason: reason.trim(), record_hash: view.record_hash }));
          }}
        >
          <p data-testid="auto-closed-statement">{view.autonomy?.statement}.</p>
          <p>
            <label>
              Reason for reopening{" "}
              <textarea rows={2} value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} />
            </label>
          </p>
          <button type="submit" disabled={busy || reopenBlocked !== undefined}>
            Reopen this close
          </button>{" "}
          {reopenBlocked ? <span className="muted">{reopenBlocked}</span> : null}
        </form>
      ) : null}

      {view.actions_taken.length > 0 ? (
        <ol className="events" aria-label="What people did">
          {view.actions_taken.map((a) => (
            <li key={`${a.actor}-${a.at}`}>
              <strong>{a.actor}</strong> ({a.role?.replace("_", " ")}){" "}
              {a.action === "approve"
                ? "approved"
                : a.action === "override"
                  ? "overrode to"
                  : a.action === "second_approval"
                    ? "gave the second approval for"
                    : a.action === "reopen"
                      ? "reopened the automatic close"
                      : "declined the block, so"}{" "}
              {a.outcome ? DECISION_LABEL[a.outcome] : ""}: <em>{a.reason}</em>{" "}
              <span className="muted">{new Date(a.at).toLocaleString()}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {view.status === "awaiting" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (blockedBy) return;
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
              <input
                type="radio"
                name="action"
                checked={action === "override"}
                onChange={() => setAction("override")}
              />{" "}
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
          <p>
            <label>
              Reason (required, shown in the record){" "}
              <textarea
                rows={3}
                value={reason}
                maxLength={600}
                onChange={(e) => setReason(e.target.value)}
                aria-describedby="decision-hint"
                style={{ width: "100%" }}
              />
            </label>
          </p>
          <p id="decision-hint" className="muted">
            {chosen === "RECOMMEND_BLOCK"
              ? "A block is not final: it waits for a second, different approver, and even then it is only a recommendation for the sanctions officer."
              : "Nothing is sent or executed. Approving prepares the next record below; you can read it before anyone acts on it."}
          </p>
          <button type="submit" disabled={busy || blockedBy !== undefined}>
            {busy ? "Saving…" : action === "approve" ? "Approve" : "Override"}
          </button>{" "}
          {blockedBy ? <span className="muted">{blockedBy}</span> : null}
        </form>
      ) : null}

      {waitingForSecond ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!secondBlocked)
              void submit(() =>
                postSecondApproval(alertId, { approve: true, reason: reason.trim(), record_hash: view.record_hash }),
              );
          }}
        >
          <p>
            <label>
              Reason for the second approval{" "}
              <textarea rows={2} value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} />
            </label>
          </p>
          <button type="submit" disabled={busy || secondBlocked !== undefined}>
            Give the second approval
          </button>{" "}
          <button
            type="button"
            className="secondary"
            disabled={busy || secondBlocked !== undefined}
            onClick={() =>
              void submit(() =>
                postSecondApproval(alertId, { approve: false, reason: reason.trim(), record_hash: view.record_hash }),
              )
            }
          >
            Decline the block
          </button>{" "}
          {secondBlocked ? <span className="muted">{secondBlocked}</span> : null}
        </form>
      ) : null}

      <p>
        <button type="button" className="secondary" onClick={() => void download("pdf")}>
          Download case file (PDF)
        </button>{" "}
        <button type="button" className="secondary" onClick={() => void download("md")}>
          Download case file (Markdown)
        </button>
      </p>

      <h3>Case file: what happens next</h3>
      {view.next_actions.length === 0 ? (
        <p className="muted">Nothing is prepared until a person has decided.</p>
      ) : (
        <ul className="plain">
          {view.next_actions.map((a) => (
            <li key={a.action_id}>
              <strong>{KIND_LABEL[a.body.kind]}</strong> <span className="badge tone-wait">{a.body.status}</span>{" "}
              <span className="muted">not sent; {CHECK_LABEL[a.check]}</span>
              <pre className="note">{a.body.content}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

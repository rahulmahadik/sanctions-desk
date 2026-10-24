"use client";

import { label, percent } from "../lib/format";
import type { EvidenceView, ScreenerRecordView, ScreenerSignalView } from "../lib/types";

/** The policy's two screener lines: one for every signal type, one for the type "other". */
export interface SignalThresholds {
  normal: number;
  other: number;
}

/** The free-text field a span id points into, and the text there, read from the evidence the reviewer already sees. */
function fieldText(evidence: EvidenceView | undefined, field: string): string | undefined {
  const [table, column] = field.split(".");
  const row =
    table === "customer"
      ? evidence?.customer
      : table === "payment"
        ? evidence?.payment
        : table === "list_entry"
          ? evidence?.list_entry
          : undefined;
  const value = column ? row?.[column] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** "customer.notes:12-40" → the field and the offsets; "customer.notes:unlocated" → the field only. */
export function parseSpan(spanId: string): { field: string; start?: number; end?: number } {
  const at = spanId.lastIndexOf(":");
  const field = at < 0 ? spanId : spanId.slice(0, at);
  const range = /^(\d+)-(\d+)$/.exec(at < 0 ? "" : spanId.slice(at + 1));
  return range ? { field, start: Number(range[1]), end: Number(range[2]) } : { field };
}

/** What the signal does to a close, in the words the reviewer sees. */
export function signalStatus(s: ScreenerSignalView, t: SignalThresholds | undefined): string {
  const line = s.type === "other" ? t?.other : t?.normal;
  const blocks = line === undefined ? undefined : s.confidence >= line;
  if (s.grounded === false)
    return blocks === false
      ? `not grounded: shown for review; below its threshold (${line}), so it does not block a close`
      : "not grounded: shown for review, still blocks a close";
  const grounded =
    s.grounded === true
      ? "grounded: a relation term and a name were found at this span"
      : "grounding not checked (record made before policy version 7)";
  if (blocks === undefined) return grounded;
  return `${grounded}; ${blocks ? "blocks a close" : `below its threshold (${line}), so it does not block a close`}`;
}

/** One signal: its type and confidence, its source field and span with the text there, and what it does to a close. */
function SignalItem({
  signal: s,
  evidence,
  thresholds,
}: {
  signal: ScreenerSignalView;
  evidence?: EvidenceView;
  thresholds?: SignalThresholds;
}) {
  const span = parseSpan(s.span_id);
  const located = s.span_valid && span.start !== undefined && span.end !== undefined;
  const full = fieldText(evidence, span.field);
  const text = located ? full?.slice(span.start, span.end) : undefined;
  const status = signalStatus(s, thresholds);
  const tone = s.grounded === false || /blocks a close/.test(status) ? "block" : "pending";
  return (
    <li data-testid="signal" style={{ marginBottom: 10 }}>
      <strong>{label(s.type)}</strong> {percent(s.confidence)} · source <code>{span.field}</code>
      {located ? (
        <>
          , characters {span.start}–{span.end}
          {text !== undefined ? <span className="sr-only">: {text}</span> : null}
        </>
      ) : (
        ", no location in the text (the span the model named does not point into the field)"
      )}
      {located && full !== undefined && text !== undefined ? (
        <div className="field-text" data-testid="signal-field">
          {full.slice(0, span.start)}
          <mark className="span" data-testid="signal-span">
            {text}
          </mark>
          {full.slice(span.end)}
        </div>
      ) : null}
      <span className="pill" data-tone={tone} data-testid="signal-status">
        <span className="icon" aria-hidden="true">
          {s.grounded === false ? "!" : tone === "block" ? "⊘" : "○"}
        </span>
        {status}
      </span>
      {s.grounded === false && s.grounding_reason ? <span className="muted"> ({s.grounding_reason})</span> : null}
    </li>
  );
}

/**
 * The screener's risk signals, each with its source field and the exact text span it points at, so a reviewer can see
 * what the desk can prove. A signal that is not grounded is shown and labelled, never hidden.
 */
export function SignalsPanel({
  screener,
  evidence,
  thresholds,
}: {
  screener?: ScreenerRecordView;
  evidence?: EvidenceView;
  thresholds?: SignalThresholds;
}) {
  if (!screener) return null;
  return (
    <section aria-labelledby="signals-title" className="panel">
      <h2 id="signals-title">Risk signals from the free text</h2>
      {screener.status !== "ok" ? (
        <p className={screener.status === "failed" ? "tone-stop" : "muted"}>
          {screener.status === "failed"
            ? "The free text could not be read, so it was not assessed; the case cannot be closed."
            : screener.status === "off"
              ? "The screener is off by policy: the free text was not read."
              : "There was no note, payment reference or list remark to read."}
        </p>
      ) : screener.signals.length === 0 ? (
        <p className="muted">The screener read {screener.fields_read.join(", ")} and found no risk signal.</p>
      ) : (
        <ul data-testid="signals">
          {screener.signals.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two signals can share a type and a span
            <SignalItem key={i} signal={s} evidence={evidence} thresholds={thresholds} />
          ))}
        </ul>
      )}
      {thresholds ? (
        <p className="muted">
          Thresholds of the active policy: {thresholds.normal} for every signal type, {thresholds.other} for "other".
          Every signal at or above its threshold blocks a close, grounded or not; grounding only adds context.
        </p>
      ) : null}
    </section>
  );
}

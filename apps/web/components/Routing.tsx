"use client";

import { type ReactNode, useState } from "react";
import { fetchReceiptCheck } from "../lib/api";
import { label, modelName, money, seconds, shortHash } from "../lib/format";
import { agentLabel } from "../lib/graph";
import type { ReceiptCheck, RoutingSplit, TraceView } from "../lib/types";

/** The step a ledger row belongs to. Every row is a model call, so one under the policy guard's name is the safety guard's. */
const stepName = (agent: string): string => agentLabel(agent, "model_answer");

const RECEIPT_TEXT: Record<ReceiptCheck["status"], string> = {
  valid_pinned: "signature valid, and the signing key is the one pinned in the configuration",
  valid_unpinned:
    "signature valid; the key came with the receipt, so it shows the receipt was not altered, not who signed it",
  invalid: "the signature does not match the receipt",
  malformed: "this is not a well-formed receipt",
};

/** Checks one signed receipt through the API and says, in words, what it proves. When the model the receipt names is not
 * the one the trace recorded, both are shown. */
function VerifyReceipt({ receiptId, traceModel }: { receiptId: string; traceModel?: string }) {
  const [check, setCheck] = useState<ReceiptCheck>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      setCheck(await fetchReceiptCheck(receiptId));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void run()}
        aria-label={`Verify receipt ${receiptId}`}
      >
        {busy ? "Checking…" : "Verify receipt"}
      </button>
      {problem ? (
        <span role="alert" className="tone-stop">
          {" "}
          {problem}
        </span>
      ) : null}
      {check ? (
        <div className="muted" data-testid={`receipt-${receiptId}`}>
          <strong className={check.status.startsWith("valid") ? "tone-calm" : "tone-stop"}>
            {check.status.startsWith("valid") ? "Verified" : "Not verified"}
          </strong>
          : {RECEIPT_TEXT[check.status]}.
          {check.served_by ? (
            <>
              {" "}
              Served by <strong>{modelName(check.served_by)}</strong> ({check.route_kind}) for app {check.app}; asked
              for {check.requested_mode}, routed as {check.routed_mode}
              {check.mode_coerced ? " (the cockpit's bind replaced the request)" : ""}. Body{" "}
              {shortHash(check.body_hash)}.
            </>
          ) : null}
          {check.served_by && traceModel && check.served_by !== traceModel ? (
            <strong className="tone-stop" data-testid={`receipt-differs-${receiptId}`}>
              {" "}
              The receipt names {check.served_by}; the trace recorded {traceModel}.
            </strong>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** True when the model named in a receipt is a Nemotron model. */
const isNemotron = (model: string | null | undefined): boolean => /nemotron/i.test(model ?? "");

/** Checks every receipt of the recommendation in turn and says how many verified and how many name a Nemotron model. */
function VerifyAll({ receiptIds }: { receiptIds: readonly string[] }) {
  const [checks, setChecks] = useState<ReceiptCheck[]>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      setChecks(await Promise.all(receiptIds.map((id) => fetchReceiptCheck(id))));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const valid = checks?.filter((c) => c.status.startsWith("valid")).length ?? 0;
  const nemotron = checks?.filter((c) => isNemotron(c.served_by)).length ?? 0;
  return (
    <p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run()}>
        {busy ? "Checking…" : `Verify all ${receiptIds.length} receipts`}
      </button>
      {problem ? (
        <span role="alert" className="tone-stop">
          {" "}
          {problem}
        </span>
      ) : null}
      {checks ? (
        <span data-testid="verify-all">
          {" "}
          <strong className={valid === checks.length ? "tone-calm" : "tone-stop"}>
            {valid} of {checks.length} signatures valid
          </strong>
          ; {nemotron} of {checks.length} name a Nemotron model as the one that served the call.
        </span>
      ) : null}
    </p>
  );
}

/**
 * A wide table in its own sideways-scrolling box, so a phone-width page never scrolls sideways. The box can take
 * keyboard focus (arrow keys scroll it) and is named for screen readers.
 */
export function TableScroll({ name, children }: { name: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to be scrolled
    <section className="table-wrap" tabIndex={0} aria-label={name} data-testid="table-scroll">
      {children}
    </section>
  );
}

/**
 * The measured split: for each step, the share of its calls each model served, read from the signed receipts of the
 * latest full exam. We ask Nightshift for a pinned mode; its learned router decides which model serves it.
 */
export function SplitTable({ split }: { split: RoutingSplit }) {
  const models = [...new Set(split.rows.flatMap((r) => r.models.map((m) => m.model)))].sort();
  const kind = (model: string) => split.rows.flatMap((r) => r.models).find((m) => m.model === model)?.kind;
  return (
    <>
      <h3>Where the calls were answered (latest full exam)</h3>
      <TableScroll name="Share of each step's calls by model (scrolls sideways)">
        <table data-testid="routing-split">
          <caption className="sr-only">Share of each step's calls served by each model</caption>
          <thead>
            <tr>
              <th>Step</th>
              <th>Calls</th>
              {models.map((m) => (
                <th key={m}>
                  {modelName(m)} ({kind(m)})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {split.rows.map((row) => (
              <tr key={row.step}>
                <td>{row.step}</td>
                <td>{row.calls}</td>
                {models.map((m) => {
                  const x = row.models.find((y) => y.model === m);
                  return <td key={m}>{x ? `${(x.share * 100).toFixed(1)}% (${x.calls})` : "0"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <p className="muted">
        We ask for a pinned mode and record the model that answered. Which model serves a mode is Nightshift's learned
        router's choice, inside the mode each app identity is bound to in the cockpit: in{" "}
        {split.receipts - split.routed_auto} of {split.receipts} receipts the mode served was the bound one, in{" "}
        {split.routed_auto} the runtime's own auto ({split.mode_coerced} marked as replaced). We do not route by
        difficulty and do not pin the cloud.
      </p>
    </>
  );
}

/** Which model answered each step, what it took, and whether its signed receipt checks out. */
export function RoutingPanel({ trace, split }: { trace: TraceView; split?: RoutingSplit | null }) {
  const { cost } = trace;
  return (
    <section aria-labelledby="routing-title" className="panel">
      <h2 id="routing-title">Model routing and cost</h2>
      <TableScroll name="Models used by step (scrolls sideways)">
        <table>
          <caption className="sr-only">Models used by step</caption>
          <thead>
            <tr>
              <th>Step</th>
              <th>Requested</th>
              <th>Routed (served the call)</th>
              <th>Receipt id</th>
              <th>Where</th>
              <th>Reasoning budget (ours)</th>
              <th>Time</th>
              <th>Tokens in / out</th>
              <th>App</th>
              <th>Receipt check</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {cost.models.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a step can appear more than once
              <tr key={i}>
                <td>{stepName(m.agent)}</td>
                <td>{m.model_requested}</td>
                <td>
                  {modelName(m.model_routed)} <span className="muted">({m.model_routed})</span>
                </td>
                <td>
                  <code data-testid="receipt-id">{m.receipt_id ?? "none"}</code>
                </td>
                <td>
                  <span className={`badge lane-${m.route_kind ?? "local"}`}>{m.route_kind ?? "local"}</span>
                </td>
                <td>{m.reasoning}</td>
                <td>{seconds(m.latency_ms)}</td>
                <td>
                  {m.tokens_in ?? 0} / {m.tokens_out ?? 0}
                </td>
                <td>{m.app ?? "—"}</td>
                <td>
                  {label(m.receipt_status)}
                  {m.receipt_id ? (
                    <>
                      {" "}
                      <VerifyReceipt receiptId={m.receipt_id} traceModel={m.model_routed} />
                    </>
                  ) : null}
                </td>
                <td>{money(m.cost, cost.currency)}</td>
              </tr>
            ))}
            {cost.models.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  No model was called for this recommendation.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableScroll>
      <p className="muted">
        For every call: the mode we asked for, the model that served it (as Nightshift reported it) and the id of its
        signed receipt, side by side. They are never merged: when the routed model is not the one asked for, both are
        shown, and a receipt that names another model than the trace is marked.
      </p>
      {cost.models.some((m) => m.receipt_id) ? (
        <VerifyAll receiptIds={cost.models.flatMap((m) => (m.receipt_id ? [m.receipt_id] : []))} />
      ) : null}
      <p>
        Totals: {cost.totals.local_calls} local and {cost.totals.cloud_calls} cloud calls, {cost.totals.tokens_in}{" "}
        tokens in, {cost.totals.tokens_out} out. Data: {cost.data_queries.count} queries,{" "}
        {cost.data_queries.rows_returned} rows, {cost.data_queries.cache_hits} from the saved cache. Total{" "}
        {money(cost.totals.total_cost, cost.currency)}.
      </p>
      <p className="muted">{cost.assumption}</p>
      {split ? <SplitTable split={split} /> : null}
    </section>
  );
}

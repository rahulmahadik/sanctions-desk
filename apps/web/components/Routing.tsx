"use client";

import { useState } from "react";
import { fetchReceiptCheck } from "../lib/api";
import { label, modelName, money, seconds, shortHash } from "../lib/format";
import type { ReceiptCheck, RoutingSplit, TraceView } from "../lib/types";

const RECEIPT_TEXT: Record<ReceiptCheck["status"], string> = {
  valid_pinned: "signature valid, and the signing key is the one pinned in the configuration",
  valid_unpinned:
    "signature valid; the key came with the receipt, so it shows the receipt was not altered, not who signed it",
  invalid: "the signature does not match the receipt",
  malformed: "this is not a well-formed receipt",
};

/** Checks one signed receipt through the API and says, in words, what it proves. */
function VerifyReceipt({ receiptId }: { receiptId: string }) {
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
        </div>
      ) : null}
    </>
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
      <div className="table-wrap">
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
      </div>
      <p className="muted">
        We ask for a pinned mode and record the model that answered. Which model serves a mode is Nightshift's learned
        router's choice: in {split.routed_auto} of {split.receipts} receipts the mode served was the runtime's own auto
        ({split.mode_coerced} marked as replaced). We do not route by difficulty and do not pin the cloud.
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
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Models used by step</caption>
          <thead>
            <tr>
              <th>Step</th>
              <th>Mode asked for</th>
              <th>Answered by</th>
              <th>Served</th>
              <th>Reasoning budget (ours)</th>
              <th>Time</th>
              <th>Tokens in / out</th>
              <th>App</th>
              <th>Receipt</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {cost.models.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a step can appear more than once
              <tr key={i}>
                <td>{label(m.agent)}</td>
                <td>{m.model_requested}</td>
                <td>
                  {modelName(m.model_routed)} <span className="muted">({m.model_routed})</span>
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
                      <VerifyReceipt receiptId={m.receipt_id} />
                    </>
                  ) : null}
                </td>
                <td>{money(m.cost, cost.currency)}</td>
              </tr>
            ))}
            {cost.models.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted">
                  No model was called for this recommendation.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
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

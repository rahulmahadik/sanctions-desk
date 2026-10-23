import { label, modelName, money, seconds } from "../lib/format";
import type { RoutingSplit, TraceView } from "../lib/types";

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
        router's choice: in {split.mode_coerced} of {split.receipts} receipts the requested mode was replaced by auto.
        We do not route by difficulty and do not pin the cloud.
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
                <td>{m.model_routed}</td>
                <td>
                  <span className={`badge lane-${m.route_kind ?? "local"}`}>{m.route_kind ?? "local"}</span>
                </td>
                <td>{m.reasoning}</td>
                <td>{seconds(m.latency_ms)}</td>
                <td>
                  {m.tokens_in ?? 0} / {m.tokens_out ?? 0}
                </td>
                <td>{label(m.receipt_status)}</td>
                <td>{money(m.cost, cost.currency)}</td>
              </tr>
            ))}
            {cost.models.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
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

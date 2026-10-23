import { label, money, seconds } from "../lib/format";
import type { TraceView } from "../lib/types";

/** Which model answered each step, where it ran, what it took, and whether its signed receipt checks out. */
export function RoutingPanel({ trace }: { trace: TraceView }) {
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
              <th>Asked for</th>
              <th>Answered by</th>
              <th>Lane</th>
              <th>Reasoning</th>
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
    </section>
  );
}

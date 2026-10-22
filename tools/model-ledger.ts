/**
 * Print the model ledger of a recorded run: which model answered each step, local or cloud, reasoning,
 * tokens, latency, the cost under the configured assumptions, and whether the signed receipt verified.
 *
 *   npm run ledger -- <run id>
 *   npm run ledger -- --case <alert id>
 */
import { buildTraceContract, readDecisionRecords } from "@sanctions-desk/agents";
import { loadConfig } from "@sanctions-desk/shared";

const args = process.argv.slice(2);
const byCase = args[0] === "--case";
const id = byCase ? args[1] : args[0];
if (!id) {
  console.error("usage: npm run ledger -- <run id>   |   npm run ledger -- --case <alert id>");
  process.exit(2);
}

const config = loadConfig();
const [record] = readDecisionRecords(config.logging.dir, (r) => (byCase ? r.alert_ref === id : r.run_id === id));
if (!record) {
  console.error(`no recorded recommendation for ${byCase ? "case" : "run"} ${id}`);
  process.exit(1);
}

const trace = buildTraceContract(record, config.costs);
console.log(
  `${record.alert_ref}  ${record.decision}  record ${record.record_hash.slice(0, 12)} (${trace.record.verified ? "verified" : "DOES NOT VERIFY"})`,
);
console.log(
  "agent     route  provider        routed model                             reasoning          tokens in/out   ms     receipt        cost",
);
for (const m of trace.cost.models) {
  console.log(
    [
      m.agent.padEnd(9),
      (m.route_kind ?? "?").padEnd(6),
      m.provider.padEnd(15),
      m.model_routed.slice(0, 40).padEnd(40),
      m.reasoning.slice(0, 18).padEnd(18),
      `${m.tokens_in ?? "-"}/${m.tokens_out ?? "-"}`.padEnd(15),
      String(m.latency_ms ?? "-").padEnd(6),
      m.receipt_status.padEnd(14),
      m.cost.toFixed(6),
    ].join(" "),
  );
}
const t = trace.cost.totals;
const q = trace.cost.data_queries;
console.log(
  `models: ${t.local_calls} local, ${t.cloud_calls} cloud, ${t.tokens_in}/${t.tokens_out} tokens, ${t.model_cost.toFixed(6)} ${trace.cost.currency}`,
);
console.log(
  `data: ${q.count} queries, ${q.total_latency_ms} ms, ${q.rows_returned} rows, ${q.cache_hits} from the sample cache`,
);
console.log(`total: ${t.total_cost.toFixed(6)} ${trace.cost.currency} (${trace.cost.assumption})`);

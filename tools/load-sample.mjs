/**
 * Sample-mode load test: send POST /run for a list of alerts, one at a time or with a fixed number in flight, and print
 * the throughput, the p50 and p95 time per alert and the errors. Point it at an API started in sample mode.
 *
 *   node tools/load-sample.mjs http://localhost:8031 alerts.json 5 label
 */
import { readFileSync } from "node:fs";

const [, , base, file, concurrency, label] = process.argv;
const alerts = JSON.parse(readFileSync(file, "utf8"));
const times = [];
const errors = [];
let n = 0;
async function one(a) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...a, run_id: `load-${label}-${a.alert_id}-${n++}` }),
    });
    const body = await r.json();
    if (r.status !== 200 || body.status !== "ok")
      errors.push(`${a.alert_id} ${r.status} ${body.error?.type ?? body.status}`);
  } catch (e) {
    errors.push(`${a.alert_id} ${e.message}`);
  }
  times.push((performance.now() - t0) / 1000);
}
const start = performance.now();
const queue = [...alerts];
await Promise.all(
  Array.from({ length: Number(concurrency) }, async () => {
    while (queue.length) await one(queue.shift());
  }),
);
const wall = (performance.now() - start) / 1000;
const s = [...times].sort((a, b) => a - b);
const pct = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
console.log(
  JSON.stringify({
    label,
    alerts: alerts.length,
    concurrency: Number(concurrency),
    wall_s: +wall.toFixed(2),
    per_minute: +((alerts.length / wall) * 60).toFixed(1),
    p50_s: +pct(50).toFixed(3),
    p95_s: +pct(95).toFixed(3),
    errors: errors.length,
    error_examples: errors.slice(0, 3),
  }),
);

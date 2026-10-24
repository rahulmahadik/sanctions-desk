/**
 * A small load test of the API on this machine: many concurrent requests to a few routes, with the time each takes.
 * It is meant for sample mode against a local API, where a review needs no model service.
 *
 *   npm run bench:api -- --url http://localhost:8000 --concurrency 20 --requests 200
 *
 * It sends only to the URL you give (default: localhost), refuses a URL that is not local, and writes nothing.
 */
// A module, so its top-level names do not clash with the other scripts.
export {};

const arg = (n: string, d: string) =>
  process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] as string) : d;
const base = arg("--url", "http://localhost:8000").replace(/\/$/, "");
const concurrency = Number(arg("--concurrency", "20"));
const total = Number(arg("--requests", "200"));
const host = new URL(base).hostname;
if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) {
  throw new Error(`the load test only talks to this machine; ${host} is not local`);
}

interface Target {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}
const targets: Target[] = [
  { name: "GET /health", method: "GET", path: "/health" },
  { name: "GET /alerts (the queue, 82+ alerts read through the semantic layer)", method: "GET", path: "/alerts" },
  { name: "GET /policy", method: "GET", path: "/policy" },
  { name: "GET /governance", method: "GET", path: "/governance" },
  { name: "POST /run (a full review in sample mode)", method: "POST", path: "/run", body: { alert_id: "ALR-0004" } },
];

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

async function hit(t: Target): Promise<{ ms: number; ok: boolean }> {
  const started = performance.now();
  try {
    const res = await fetch(`${base}${t.path}`, {
      method: t.method,
      ...(t.body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(t.body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - started, ok: res.status < 500 && res.status !== 429 };
  } catch {
    return { ms: performance.now() - started, ok: false };
  }
}

console.log(`${total} requests per route, ${concurrency} at a time, against ${base}\n`);
console.log("| Route | Requests | Errors | Median ms | p95 ms | Max ms | Requests/s |\n|---|--:|--:|--:|--:|--:|--:|");
for (const t of targets) {
  const times: number[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (next < total) {
        next += 1;
        const r = await hit(t);
        times.push(r.ms);
        if (!r.ok) errors += 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  console.log(
    `| ${t.name} | ${total} | ${errors} | ${pct(times, 50).toFixed(1)} | ${pct(times, 95).toFixed(1)} | ${(times.at(-1) ?? 0).toFixed(1)} | ${(total / seconds).toFixed(1)} |`,
  );
}

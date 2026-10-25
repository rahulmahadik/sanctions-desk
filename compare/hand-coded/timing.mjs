// Times the direct reads for `npm run zetaris:timing`: the same reads the desk makes through Zetaris, made straight
// against the bank database, the payments service and the list files. Read-only, one statement per call, timeouts.
// Runs in a container on the sources' network (they publish no host port); prints one JSON object on stdout.
import { readFileSync } from "node:fs";
import pg from "pg";

const env = process.env;
const repeats = Number(env.REPEATS ?? 20);
const reads = JSON.parse(env.READS ?? "[]");
const now = () => performance.now();
const round = (n) => Math.round(n * 10) / 10;

async function timed(fn) {
  const ms = [];
  let rows = 0;
  for (let i = 0; i < repeats; i += 1) {
    const t0 = now();
    rows = await fn();
    ms.push(round(now() - t0));
  }
  return { ms, rows };
}

const client = new pg.Client({
  host: env.BANKDB_HOST,
  port: Number(env.BANKDB_PORT ?? 5432),
  user: "zetaris_reader",
  password: env.BANKDB_READER_PASSWORD,
  database: "bank",
  connectionTimeoutMillis: 10000,
  query_timeout: 15000,
});
const t0 = now();
await client.connect();
const connectMs = round(now() - t0);

const out = [];
try {
  for (const r of reads) {
    if (r.source === "bank") {
      const sql = `SELECT ${r.columns.join(", ")} FROM ${r.table} WHERE ${r.key} = $1`;
      out.push({ id: r.id, ...(await timed(async () => (await client.query(sql, [r.value])).rowCount)) });
    } else if (r.source === "payments") {
      const url = `${env.PAYMENTS_URL}/payments?${r.key}=${encodeURIComponent(r.value)}`;
      out.push({
        id: r.id,
        ...(await timed(async () => {
          const res = await fetch(url, {
            headers: { "x-api-key": env.PAYMENTS_API_KEY },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`payments service answered ${res.status}`);
          return (await res.json()).length;
        })),
      });
    } else if (r.source === "lists") {
      const file = `${env.LISTS_DIR}/${r.table}.json`;
      out.push({
        id: r.id,
        ...(await timed(async () => JSON.parse(readFileSync(file, "utf8")).filter((x) => x[r.key] === r.value).length)),
      });
    }
  }
} finally {
  await client.end();
}
console.log(JSON.stringify({ connect_ms: connectMs, reads: out }));

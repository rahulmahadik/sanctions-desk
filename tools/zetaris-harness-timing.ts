/**
 * Query time on the same reads, through Zetaris and directly against each source. Live: needs Zetaris, the bank
 * database and the payments service running, `.env` (the eval token) and `.env.data` (passed to Docker only).
 *
 *   npm run zetaris:timing                          # 20 timed calls per read, plus one first call reported apart
 *   npm run zetaris:timing -- --repeats 50 --alert ALR-0002
 *   npm run zetaris:timing -- --dry-run             # prints the reads and statements; contacts nothing
 *
 * Every statement is one read-only SELECT on a key, sent through the desk's own Zetaris client (SQL guard, timeout,
 * role `eval`). The direct reads run in a container on the sources' network, because the bank database and the
 * payments service publish no host port (compare/hand-coded/timing.mjs: one Postgres connection with a query timeout,
 * the payments service with a request timeout, the list file read and filtered). Writes eval/zetaris-timing.json, then
 * refreshes the block in docs/ZETARIS.md through `npm run zetaris:harness`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, median, percentile, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, USL_TABLES } from "@sanctions-desk/zetaris";
import { formatMarkdown } from "./lib/format-markdown.js";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string =>
  args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback;
const repeats = Number(arg("--repeats", "20"));
const alertId = arg("--alert", "ALR-0001");
const dryRun = args.includes("--dry-run");
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 500) throw new Error("--repeats must be 1 to 500");

const envFile = join(projectRoot(), ".env");
if (!dryRun && existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const model = `${config.zetaris.namespace}.${config.zetaris.usl}`;

// The keys come from the synthetic bank files, so the same rows are read on both paths.
const alerts = JSON.parse(readFileSync(resolveProjectPath("data/synthetic/alert.json"), "utf8")) as Array<
  Record<string, string | null>
>;
const alert = alerts.find((a) => a.alert_id === alertId);
if (!alert?.customer_id || !alert.entry_id) throw new Error(`${alertId}: no customer or list entry in the alert file`);
const SAFE = /^[A-Za-z0-9._-]+$/;

interface Read {
  id: string;
  source: "bank" | "payments" | "lists";
  table: string;
  key: string;
  value: string;
  columns: string[];
}
const columnsOf = (table: string): string[] => {
  const spec = USL_TABLES.find((t) => t.name === table);
  if (!spec) throw new Error(`${table} is not a table of the model`);
  // Identifier numbers are left out on both paths: the timing does not need them.
  return spec.columns.filter((c) => !c.sensitive && c.name !== "id_number").map((c) => c.name);
};
const read = (id: string, source: Read["source"], table: string, key: string, value: string): Read => {
  if (!SAFE.test(value)) throw new Error(`unexpected key value for ${id}`);
  return { id, source, table, key, value, columns: columnsOf(table) };
};
const READS: Read[] = [
  read("alert by id", "bank", "alert", "alert_id", alertId),
  read("customer by id", "bank", "customer", "customer_id", alert.customer_id),
  read("customer identifiers of the customer", "bank", "customer_identifier", "customer_id", alert.customer_id),
  read("payments of the customer", "payments", "payment", "customer_id", alert.customer_id),
  read("listed entry by id", "lists", "list_entry", "entry_id", alert.entry_id),
];
const sqlOf = (r: Read) => `SELECT ${r.columns.join(", ")} FROM ${model}.${r.table} WHERE ${r.key} = '${r.value}'`;

if (dryRun) {
  console.log(`DRY RUN: ${READS.length} reads, ${repeats} timed calls each plus one first call, alert ${alertId}`);
  for (const r of READS) console.log(`  ${r.source.padEnd(8)} ${r.id}\n    Zetaris: ${sqlOf(r)}`);
  console.log("Nothing was sent.");
  process.exit(0);
}

interface Stats {
  n: number;
  first_ms: number;
  median_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  rows: number;
}
const round = (n: number) => Math.round(n * 10) / 10;
const stats = (ms: number[], rows: number): Stats => {
  const [first = 0, ...rest] = ms;
  return {
    n: rest.length,
    first_ms: round(first),
    median_ms: round(median(rest)),
    p95_ms: round(percentile(rest, 95)),
    min_ms: round(Math.min(...rest)),
    max_ms: round(Math.max(...rest)),
    rows,
  };
};

// ---- through Zetaris ------------------------------------------------------------------------------------------------

const client = createZetarisClient({ config });
client.setAllowedTables(READS.map((r) => `${model}.${r.table}`));
if (client.tokenSource("eval") !== "role") throw new Error("ZETARIS_TOKEN_EVAL is not set; the timing runs as eval");
const viaZetaris = new Map<string, Stats & { query_ids: string[] }>();
for (const r of READS) {
  const ms: number[] = [];
  const ids: string[] = [];
  let rows = 0;
  for (let i = 0; i <= repeats; i += 1) {
    const t0 = performance.now();
    const res = await client.query("eval", sqlOf(r));
    ms.push(performance.now() - t0);
    ids.push(res.query_id);
    rows = res.row_count;
  }
  viaZetaris.set(r.id, { ...stats(ms, rows), query_ids: ids });
  console.log(`zetaris  ${r.id}: median ${viaZetaris.get(r.id)?.median_ms} ms`);
}

// ---- directly, from a container on the sources' network ------------------------------------------------------------

const root = projectRoot();
const out = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "zetaris_default",
    "--env-file",
    ".env.data",
    "-e",
    "BANKDB_HOST=sanctions-bankdb",
    "-e",
    "PAYMENTS_URL=http://sanctions-payments-api:8100",
    "-e",
    "LISTS_DIR=/lists",
    "-e",
    `REPEATS=${repeats + 1}`,
    "-e",
    `READS=${JSON.stringify(READS)}`,
    "-v",
    `${root}/compare/hand-coded:/hand-coded:ro`,
    "-v",
    `${root}/data/sample:/lists:ro`,
    "-w",
    "/hand-coded",
    "--entrypoint",
    "node",
    "sanctions-desk-api:local",
    "timing.mjs",
  ],
  { cwd: root, encoding: "utf8", timeout: 300_000 },
);
const direct = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
  connect_ms: number;
  reads: Array<{ id: string; ms: number[]; rows: number }>;
};
for (const r of direct.reads) console.log(`direct   ${r.id}: median ${round(median(r.ms.slice(1)))} ms`);

// ---- output ---------------------------------------------------------------------------------------------------------

const result = {
  note: "Written by npm run zetaris:timing (a live run); do not edit by hand.",
  measured_at: new Date().toISOString(),
  alert: alertId,
  repeats,
  direct_connect_ms: direct.connect_ms,
  reads: READS.map((r) => {
    const d = direct.reads.find((x) => x.id === r.id);
    return {
      read: r.id,
      source: r.source,
      zetaris_sql: sqlOf(r),
      zetaris: viaZetaris.get(r.id) ?? null,
      direct: d ? stats(d.ms, d.rows) : null,
    };
  }),
  notes: [
    "Zetaris times are end to end from this machine through the desk's own client (SQL guard, HTTP, parsing), as the eval identity, on the semantic-layer table.",
    `Direct times are taken inside a container on the sources' network with no guard; the Postgres connection is opened once (${direct.connect_ms} ms, not in the times).`,
    "The payment table in Zetaris is cached, so that read does not call the payments service; the direct read does.",
    "The first call of each read is reported apart (first_ms) and left out of the median and p95.",
  ],
};
const timingFile = resolveProjectPath("eval/zetaris-timing.json");
writeFileSync(timingFile, formatMarkdown(`${JSON.stringify(result, null, 2)}\n`, timingFile));
console.log("wrote eval/zetaris-timing.json");
execFileSync("npx", ["tsx", "tools/zetaris-harness.ts"], { cwd: root, stdio: "inherit", timeout: 120_000 });

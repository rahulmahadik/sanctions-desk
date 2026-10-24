// Time the Zetaris onboarding steps from the setup logs (logs/zetaris-setup-*.jsonl): the latest time each statement was applied.
// Each statement's latency was measured by the setup tool when it ran. Read-only: it only reads the logs.
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../logs/", import.meta.url).pathname;
const logs = readdirSync(dir)
  .filter((f) => f.startsWith("zetaris-setup-"))
  .sort();
const rows = logs
  .flatMap((f) =>
    readFileSync(dir + f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  )
  .filter((r) => r.mode === "apply" && r.outcome === "applied");
const lastCompile = rows.filter((r) => r.name === "compile_model").at(-1);
// Only statements that are in the current scripts count; names from earlier versions of the scripts are left out.
const sqlDir = new URL("../zetaris/sql/", import.meta.url).pathname;
const current = new Set(
  readdirSync(sqlDir)
    .filter((f) => f.endsWith("_create.sql") && !f.startsWith("00_") && !f.startsWith("06_activate_files"))
    .flatMap((f) => [...readFileSync(sqlDir + f, "utf8").matchAll(/^-- @@ (\S+)/gm)].map((m) => m[1])),
);
const latest = new Map(rows.filter((r) => current.has(r.name)).map((r) => [r.name, r]));
const steps = [
  ["create the sources: lists (file store)", (n) => n === "db_lists" || n.startsWith("file_")],
  ["create the sources: bank database (JDBC)", (n) => n === "datasource_bankdb" || n === "register_bankdb_tables"],
  [
    "create the sources: payments (REST) and cache it",
    (n) => ["db_payments", "rest_payments", "cache_payments"].includes(n),
  ],
  ["compile the model (namespaces and tables)", (n) => ["ns_metastore", "ns_sanctions", "compile_model"].includes(n)],
  ["activate the tables", (n) => n.startsWith("activate_")],
  ["describe tables and columns", (n) => n.startsWith("describe_")],
  ["register data-quality rules", (n) => n.startsWith("dq_")],
  ["roles and grants", (n) => n.startsWith("create_role_") || n.startsWith("grant_")],
];
let total = 0;
console.log(`Latest applied time of each statement; the model was last compiled at ${lastCompile?.ts ?? "unknown"}`);
console.log("step".padEnd(52), "statements".padStart(10), "seconds".padStart(8));
for (const [label, match] of steps) {
  const chosen = [...latest.values()].filter((r) => match(r.name));
  const ms = chosen.reduce((s, r) => s + r.latency_ms, 0);
  total += ms;
  console.log(label.padEnd(52), String(chosen.length).padStart(10), (ms / 1000).toFixed(1).padStart(8));
}
console.log("total".padEnd(52), "".padStart(10), (total / 1000).toFixed(1).padStart(8));

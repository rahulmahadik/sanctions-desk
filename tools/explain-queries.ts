/**
 * Record the query plans (EXPLAIN) of the key queries the review sends, from the live Zetaris, into
 * docs/QUERY_PLANS.md. EXPLAIN needs the admin key, so this is a documentation tool, not part of a review.
 *
 *   npm run explain
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpRequest, loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}
const config = loadConfig();
const z = config.zetaris;
if (!z.apiKey) throw new Error("the admin key is needed to ask for a query plan");
const Q = `${z.namespace}.${z.usl}`;

const QUERIES: Array<{ title: string; why: string; sql: string }> = [
  {
    title: "Read one alert by its key",
    why: "The first read of every review.",
    sql: `SELECT \`alert_id\`, \`customer_id\`, \`entry_id\`, \`match_score\` FROM ${Q}.alert WHERE \`alert_id\` = 'ALR-0001' ORDER BY \`alert_id\` LIMIT 200`,
  },
  {
    title: "Which customer identifiers equal a listed party's identifiers",
    why: "Done inside Zetaris so that identifier numbers never leave it; only the types that match come back.",
    sql: `SELECT ci.id_type AS id_type, COUNT(*) AS n FROM ${Q}.customer_identifier ci JOIN ${Q}.list_identifier li ON regexp_replace(upper(ci.id_number), '[^A-Z0-9]', '') = regexp_replace(upper(li.id_number), '[^A-Z0-9]', '') WHERE ci.customer_id = 'CUST-0001' AND li.entry_id = 'OFAC-1' GROUP BY ci.id_type`,
  },
  {
    title: "Read the ownership register one level up",
    why: "The ownership step reads the register level by level from the customer upwards.",
    sql: `SELECT \`ownership_id\`, \`owned_party_id\`, \`owner_party_id\`, \`ownership_pct\` FROM ${Q}.beneficial_owner WHERE \`owned_party_id\` IN ('CUST-0035') ORDER BY \`ownership_id\``,
  },
  {
    title: "List-change replay: current state of the decided entries",
    why: "Compares the content hash recorded with each earlier decision with the entry as it is now.",
    sql: `SELECT \`entry_id\`, \`primary_name\`, \`content_hash\`, \`snapshot_id\` FROM ${Q}.list_entry WHERE \`entry_id\` IN ('OFAC-1', 'OFAC-2', 'UN-1')`,
  },
  {
    title: "List-change replay: open alerts and pending payments of affected customers",
    why: "Gives the portfolio impact of a list update.",
    sql: `SELECT p.customer_id, COUNT(*) AS pending_payments, SUM(p.amount) AS pending_amount FROM ${Q}.payment p WHERE p.status = 'pending' AND p.customer_id IN ('CUST-0051', 'CUST-0052') GROUP BY p.customer_id`,
  },
];

async function explain(sql: string): Promise<string> {
  const queryId = crypto.randomUUID();
  const response = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${z.apiKey?.reveal()}`, "X-Org-ID": z.orgId, "X-Request-ID": queryId },
    timeoutMs: z.requestTimeoutMs * 2,
    body: { queryId, sql: `EXPLAIN QUERY AS ${sql}`, source: "SqlEditor", limit: 200 },
  });
  if (response.status !== 200) return `(Zetaris answered HTTP ${response.status})`;
  const rows = (JSON.parse(response.text) as { data: unknown[][] }).data;
  return rows
    .map((r) => String(r[0] ?? ""))
    .join("\n")
    .trim();
}

const out: string[] = [
  "# Query plans",
  "",
  "The plans below were produced by Zetaris (`EXPLAIN QUERY AS ...`) on this machine for the key queries a review sends. They show that the semantic-layer tables are read through the sources they were activated from, with the filter pushed to the source where the source supports it. Regenerate with `npm run explain`.",
  "",
];
for (const q of QUERIES) {
  const plan = await explain(q.sql);
  out.push(
    `## ${q.title}`,
    "",
    q.why,
    "",
    "```sql",
    q.sql,
    "```",
    "",
    "```text",
    plan.split("\n").slice(0, 60).join("\n"),
    "```",
    "",
  );
  console.log(`${q.title}: ${plan.split("\n").length} plan lines`);
}
writeFileSync(resolveProjectPath("docs/QUERY_PLANS.md"), `${out.join("\n").trimEnd()}\n`);
console.log("wrote docs/QUERY_PLANS.md");

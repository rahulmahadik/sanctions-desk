/**
 * Mock of a proposed feature: access control declared inside the semantic-layer definition.
 *
 *   npm run usl:policy                 # read zetaris/proposals/screening_usl.access.ddl and print the plan
 *   npm run usl:policy -- --demo       # also show a mask and a row filter on real (synthetic) rows, read-only
 *   npm run usl:policy -- --apply      # run the SQL steps (CREATE ROLE, GRANT) only; ask first
 *
 * Nothing is sent without --apply. The steps that today exist only in the interface are listed, never attempted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import {
  applyProposedMask,
  applyRowFilter,
  parseProposal,
  planFor,
  runSetup,
  USL_TABLES,
} from "@sanctions-desk/zetaris";

for (const name of [".env", ".env.data"]) {
  const envFile = join(projectRoot(), name);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
const args = process.argv.slice(2);
const config = loadConfig();
const model = "lightning.metastore.sanctions.screening_usl";
const statements = parseProposal(
  readFileSync(resolveProjectPath("zetaris/proposals/screening_usl.access.ddl"), "utf8"),
);
const plan = planFor(
  statements,
  model,
  USL_TABLES.map((t) => t.name),
);

console.log(`${statements.length} proposed statements -> how each is done on the platform today`);
for (const step of plan) {
  console.log(`\n[${step.channel.toUpperCase().padEnd(9)}] ${JSON.stringify(step.statement)}`);
  for (const line of step.today.slice(0, 3)) console.log(`    ${line}`);
  if (step.today.length > 3) console.log(`    ... and ${step.today.length - 3} more`);
}
const manual = plan.filter((p) => p.channel !== "sql").length;
console.log(
  `\n${plan.length - manual} steps by SQL, ${manual} by REST or the interface only, which a SQL script cannot repeat after a rebuild.`,
);

const ask = async (sql: string) => {
  const [r] = await runSetup({ config, statements: [{ name: "q", sql }], apply: true });
  if (r?.outcome !== "applied") throw new Error(r?.error ?? "no answer");
  return r;
};

if (args.includes("--demo")) {
  const mask = statements.find((s) => s.kind === "mask");
  const filter = statements.find((s) => s.kind === "row_filter");
  if (mask?.kind === "mask") {
    const r = await ask(`SELECT ${mask.column} FROM ${model}.${mask.table} ORDER BY identifier_id LIMIT 3`);
    const rows = JSON.parse(r.preview ?? "[]") as string[][];
    console.log(
      `\nmask on ${mask.table}.${mask.column} for ${mask.role} (regex ${mask.pattern} -> ${mask.replacement}):`,
    );
    for (const [value] of rows)
      console.log(
        `    ${applyProposedMask(value ?? "", mask.pattern, mask.replacement)}   (${(value ?? "").length} characters)`,
      );
  }
  if (filter?.kind === "row_filter") {
    const r = await ask(`SELECT customer_id, desk FROM ${model}.${filter.table} ORDER BY customer_id LIMIT 50`);
    const rows = (JSON.parse(r.preview ?? "[]") as string[][]).map(([customer_id, desk]) => ({
      customer_id: customer_id ?? null,
      desk: desk ?? null,
    }));
    const all = await ask(`SELECT desk, COUNT(*) AS n FROM ${model}.${filter.table} GROUP BY desk ORDER BY desk`);
    console.log(
      `\nrow filter on ${filter.table} for ${filter.role} (${filter.where}); customers per desk: ${all.preview}`,
    );
    console.log(
      `    of the first ${rows.length} customers, ${filter.role} would see ${applyRowFilter(rows, filter.where).length}`,
    );
  }
}

if (args.includes("--apply")) {
  const sql = plan.filter((p) => p.channel === "sql").flatMap((p) => p.today);
  const results = await runSetup({
    config,
    statements: sql.map((s, i) => ({ name: `s${i}`, sql: s })),
    apply: true,
    skipExists: true,
  });
  console.log(`\napplied ${results.filter((r) => r.outcome !== "failed").length} of ${sql.length} SQL steps`);
}

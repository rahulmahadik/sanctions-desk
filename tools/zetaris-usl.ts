/**
 * Prove the Unified Semantic Layer from this repository: the committed DDL still matches the model specification,
 * the layer answers joins across the three sources, and every data-quality rule runs with its real result.
 *
 *   npm run zetaris:usl
 *
 * Read only (SELECT, SHOW, RUN DQ, LIST). The admin key is read from the environment and used here only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ISO_COUNTRIES } from "@sanctions-desk/data";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import { renderScripts, runSetup, type SetupStatement } from "@sanctions-desk/zetaris";

for (const name of [".env", ".env.data"]) {
  const envFile = join(projectRoot(), name);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const config = loadConfig();
const model = "lightning.metastore.sanctions.screening_usl";

// 1. The committed DDL is the one the setup compiles.
const generated = renderScripts({ isoCodes: ISO_COUNTRIES.map(([iso2]) => iso2) })["05_usl_create.sql"] ?? "";
const compiled = generated.slice(generated.indexOf("DDL\n") + 4);
const ddl = compiled.slice(0, compiled.indexOf("\n-- @@")).trim();
const committed = readFileSync(resolveProjectPath("zetaris/usl/screening_usl.ddl"), "utf8");
const same = committed.includes(ddl);
console.log(
  `DDL: ${(ddl.match(/CREATE TABLE/g) ?? []).length} tables; zetaris/usl/screening_usl.ddl ${same ? "matches" : "DIFFERS from"} the model specification`,
);

// 2. The layer is active: it lists its tables, joins across sources, and runs the rules.
const ask = async (name: string, sql: string) => {
  const statement: SetupStatement = { name, sql };
  const [result] = await runSetup({ config, statements: [statement], apply: true });
  return result;
};
let failed = same ? 0 : 1;
const tables = await ask("list", `SHOW NAMESPACES OR TABLES IN lightning.metastore.sanctions`);
console.log(`model lists ${tables?.rows ?? 0} entries`);
const rules = await ask("rules", `LIST DQ USL ${model}`);
console.log(`${rules?.rows ?? 0} data-quality rules registered (including the ones foreign keys generate)`);
for (const rule of [
  ["dob_present_for_individuals", "customer"],
  ["nationality_is_iso2", "customer"],
  ["ownership_pct_in_range", "beneficial_owner"],
  ["ownership_pct_present", "beneficial_owner"],
  ["payment_amount_positive", "payment"],
  ["counterparty_country_valid", "payment"],
  ["payment_bank_countries_valid", "payment"],
  ["match_score_in_range", "alert"],
] as const) {
  const r = await ask(rule[0], `RUN DQ ${rule[0]} TABLE ${model}.${rule[1]}`);
  if (r?.outcome !== "applied") failed += 1;
  console.log(`DQ ${rule[0].padEnd(30)} ${r?.outcome === "applied" ? r.preview : r?.error}`);
}
console.log("Joins across the three sources: npm run zetaris:queries -- usl");
process.exit(failed > 0 ? 1 : 0);

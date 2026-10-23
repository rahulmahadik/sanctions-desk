/**
 * The new-source test on the Zetaris path, without touching the live model: bring the internal watchlist into the
 * specification in memory, render the setup scripts with and without it, and show what changes.
 *
 *   npx tsx compare/new-source/usl-path.ts --out <dir> [--with-new]     (run twice; compare/new-source/run-usl-path.sh does both)
 *
 * With --with-new it also builds the agents' evidence tools from a model description that contains the new table, to show
 * that no agent code is needed to read it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISO_COUNTRIES } from "@sanctions-desk/data";
import { WATCHLIST_TABLE } from "./watchlist.spec.ts";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1] as string;
const withNew = args.includes("--with-new");
const started = performance.now();

const spec = await import("../../packages/zetaris/src/usl-spec.ts");
if (withNew) {
  (spec.USL_TABLES as unknown[]).push(WATCHLIST_TABLE);
  (spec.USL_TABLE_ORDER as string[]).push(WATCHLIST_TABLE.name);
}
const { renderScripts } = await import("../../packages/zetaris/src/usl-sql.ts");
const scripts = renderScripts({ isoCodes: ISO_COUNTRIES.map(([iso2]) => iso2) });
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(scripts)) writeFileSync(join(out, name), text);
console.log(
  `rendered ${Object.keys(scripts).length} scripts in ${Math.round(performance.now() - started)} ms (${withNew ? "with" : "without"} the new table)`,
);

if (withNew) {
  const { parseUslModel, buildEvidenceTools } = await import("../../packages/zetaris/src/index.ts");
  const fixture = JSON.parse(readFileSync("packages/zetaris/test/fixtures/usl-model.json", "utf8"));
  const template = fixture.tables.find((t: { name: string }) => t.name === "list_country");
  const added = {
    ...template,
    name: WATCHLIST_TABLE.name,
    description: WATCHLIST_TABLE.description,
    columnSpecs: WATCHLIST_TABLE.columns.map((c, i) => ({
      name: c.name,
      dataType: `"${c.type}"`,
      description: c.description,
      dqAnnotations: [],
      acAnnotations: [],
      ...(i === 0 ? { primaryKey: { columns: [] } } : {}),
    })),
  };
  const names = (tables: unknown[]) => [
    ...buildEvidenceTools(parseUslModel({ ...fixture, tables }), undefined as never, { maskSensitive: true }).keys(),
  ];
  const before = names(fixture.tables);
  const after = names([...fixture.tables, added]);
  console.log(
    `evidence tools before: ${before.length}, after: ${after.length}; new: ${after.filter((n) => !before.includes(n)).join(", ")}`,
  );
  console.log("agent code changed: 0 lines (the tools are built from the model's own description)");
}

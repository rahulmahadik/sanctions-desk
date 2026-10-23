/**
 * Add a new version of an approved business definition to the Zetaris file store, without touching the old rows.
 *
 *   npm run zetaris:definitions             dry run: shows what the model holds now and which rows would be added
 *   npm run zetaris:definitions -- --apply  places data/sample/business_definition.json in the file store
 *
 * `business_definition` is a file-store table, so a new row is a new line in its JSON file. Nothing is rebuilt and no
 * Access Control setting changes. The apply step refuses to run if a row the model holds now differs from the same
 * row in the file (an old version is never edited or removed).
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBusinessDefinitions } from "@sanctions-desk/data";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, placeFiles } from "@sanctions-desk/zetaris";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const apply = process.argv.includes("--apply");
const config = loadConfig();
const NS = "lightning.metastore.sanctions.screening_usl";
const columns = "definition_key, definition_id, version, name, statement, status, owner, effective_from";

const client = createZetarisClient({ config });
client.setAllowedTables([`${NS}.business_definition`]);
const read = async () =>
  (await client.query("eval", `SELECT ${columns} FROM ${NS}.business_definition`)).objects as Array<
    Record<string, string | null>
  >;

const live = await read();
const wanted = loadBusinessDefinitions();
const byKey = new Map(live.map((r) => [r.definition_key, r]));
const added = wanted.filter((w) => !byKey.has(w.definition_key));
const changed = wanted.filter((w) => {
  const l = byKey.get(w.definition_key);
  return l && columns.split(", ").some((c) => (l[c] ?? null) !== ((w as Record<string, unknown>)[c] ?? null));
});
const missing = live.filter((l) => !wanted.some((w) => w.definition_key === l.definition_key));

console.log(`in the model now (${live.length}): ${live.map((r) => r.definition_key).join(", ")}`);
console.log(`in the file      (${wanted.length}): ${wanted.map((w) => w.definition_key).join(", ")}`);
for (const a of added)
  console.log(`\nwould add ${a.definition_key} (${a.status}, effective ${a.effective_from}):\n  ${a.statement}`);
if (changed.length > 0 || missing.length > 0) {
  console.error(
    `\nrefusing: ${changed.map((c) => c.definition_key).join(", ") || "-"} differ from the model and ${
      missing.map((m) => m.definition_key).join(", ") || "-"
    } are missing from the file. An existing version is never edited or removed.`,
  );
  process.exit(1);
}
if (added.length === 0) {
  console.log("\nnothing to add");
  process.exit(0);
}
if (!apply) {
  console.log("\ndry run: nothing written. Add --apply to place the file.");
  process.exit(0);
}

const staging = mkdtempSync(join(tmpdir(), "zetaris-definitions-"));
const local = join(staging, "business_definition.json");
writeFileSync(local, `${JSON.stringify(wanted)}\n`);
const { container, folder } = config.zetaris.fileStore;
const placed = await placeFiles({ container, folder }, [{ localPath: local, subfolder: "sanctions_lists" }]);
console.log(`\nplaced ${placed.length} file (${placed[0]?.bytes} bytes)`);
const after = await read();
const keys = after.map((r) => r.definition_key);
for (const a of added) {
  if (!keys.includes(a.definition_key)) {
    console.error(`${a.definition_key} is not visible through the model after the file was placed`);
    process.exit(1);
  }
}
console.log(`the model now holds ${after.length} definitions: ${keys.join(", ")}`);

/**
 * Copy the list tables, the business definitions and the synthetic bank into the Zetaris file store.
 *
 *   npm run zetaris:load-files                   the list as it is after the synthetic update (state b)
 *   npm run zetaris:load-files -- --list-state a  the list as committed, before the update
 *
 * The bank copy is the fallback source for the semantic layer; the primary sources are the bank database
 * and the payments service.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDeltaToSample, DELTA_LABEL, loadDataSources, TABLES, type TableRows } from "@sanctions-desk/data";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { placeFiles } from "@sanctions-desk/zetaris";

const state = process.argv.includes("--list-state") ? process.argv[process.argv.indexOf("--list-state") + 1] : "b";
if (state !== "a" && state !== "b") throw new Error("--list-state must be a or b");

const config = loadConfig();
const sources = loadDataSources();
const sampleDir = resolveProjectPath(sources.sample.outputDir);
const bankDir = resolveProjectPath("data/synthetic");
const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as unknown[];

let lists = {} as Record<string, unknown[]>;
for (const [name, schema] of Object.entries(TABLES)) lists[name] = schema.array().parse(read(sampleDir, name));
if (state === "b") {
  const delta = JSON.parse(readFileSync(join(bankDir, "list-delta.json"), "utf8")) as { label: string; ops: never[] };
  lists = applyDeltaToSample(lists as unknown as TableRows, delta.ops, delta.label || DELTA_LABEL) as unknown as Record<
    string,
    unknown[]
  >;
}

const staging = mkdtempSync(join(tmpdir(), "zetaris-files-"));
mkdirSync(join(staging, "lists"));
const listNames = ["list_entry", "list_alias", "list_dob", "list_country", "list_identifier"];
for (const name of listNames) writeFileSync(join(staging, "lists", `${name}.json`), `${JSON.stringify(lists[name])}\n`);
writeFileSync(
  join(staging, "lists", "business_definition.json"),
  `${JSON.stringify(read(sampleDir, "business_definition"))}\n`,
);

const bankNames = [
  "customer",
  "customer_identifier",
  "customer_alias",
  "account",
  "beneficial_owner",
  "payment",
  "alert",
  "disposition",
];
const { container, folder } = config.zetaris.fileStore;
const placed = await placeFiles({ container, folder }, [
  ...[...listNames, "business_definition"].map((t) => ({
    localPath: join(staging, "lists", `${t}.json`),
    subfolder: "sanctions_lists",
  })),
  ...bankNames.map((t) => ({ localPath: join(bankDir, `${t}.json`), subfolder: "sanctions_bank_files" })),
]);
console.log(`list state ${state}: ${placed.length} files placed`);
for (const p of placed) console.log(`${String(p.bytes).padStart(9)}  ${p.remotePath.split("/file-store/")[1]}`);

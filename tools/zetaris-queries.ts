/**
 * Run the read-only example queries under zetaris/queries/ and print what Zetaris answers.
 *
 *   npm run zetaris:queries                 # every query
 *   npm run zetaris:queries -- bankdb       # one folder
 *   npm run zetaris:queries -- --write      # also save the answers to zetaris/queries/RESULTS.md
 *
 * Only SELECT, SHOW, RUN DQ, LIST and LOAD statements are accepted; anything else stops the run. The admin key
 * is read from the environment and used here only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import { parseStatements, runSetup, type SetupStatement } from "@sanctions-desk/zetaris";

for (const name of [".env", ".env.data"]) {
  const envFile = join(projectRoot(), name);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const READ_ONLY = /^\s*(SELECT|SHOW|RUN DQ|LIST|LOAD)\b/i;
const args = process.argv.slice(2);
const write = args.includes("--write");
const folders = args.filter((a) => !a.startsWith("--"));
const root = resolveProjectPath("zetaris/queries");
const config = loadConfig();

interface Query extends SetupStatement {
  folder: string;
  question: string;
}

function questionOf(script: string, name: string): string {
  const at = script.indexOf(`-- @@ ${name}`);
  const before = script.slice(0, at).split("\n").reverse();
  const line = before.find((l) => l.startsWith("-- Question:"));
  return line ? line.replace("-- Question: ", "") : "";
}

const queries: Query[] = [];
for (const folder of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  if (folders.length > 0 && !folders.includes(folder.name)) continue;
  for (const file of readdirSync(join(root, folder.name))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const script = readFileSync(join(root, folder.name, file), "utf8");
    for (const s of parseStatements(script))
      queries.push({ ...s, folder: folder.name, question: questionOf(script, s.name) });
  }
}
const refused = queries.find((q) => !READ_ONLY.test(q.sql));
if (refused) {
  console.error(`refused: ${refused.name} is not a read-only statement`);
  process.exit(2);
}

const out: string[] = [
  "# Results of the example queries",
  "",
  "Written by `npm run zetaris:queries -- --write` from a live run. Synthetic data only.",
  "",
];
let failed = 0;
for (const q of queries) {
  const [result] = await runSetup({ config, statements: [q], apply: true });
  if (!result) continue;
  const ok = result.outcome === "applied";
  if (!ok) failed += 1;
  console.log(
    `${ok ? "ok    " : "FAILED"} ${q.folder}/${q.name}  rows=${result.rows ?? "-"}  ${result.latency_ms} ms${result.error ? `  ${result.error}` : ""}`,
  );
  if (result.preview) console.log(`       ${result.preview}`);
  out.push(
    `## ${q.folder} / ${q.name}`,
    "",
    q.question,
    "",
    "```sql",
    q.sql,
    "```",
    "",
    ok ? `Rows returned: ${result.rows}. First rows:` : `Failed: ${result.error}`,
    "",
    "```json",
    result.preview ?? "[]",
    "```",
    "",
  );
}
if (write) writeFileSync(join(root, "RESULTS.md"), `${out.join("\n")}\n`);
console.log(`${queries.length} queries, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

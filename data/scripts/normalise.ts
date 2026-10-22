/**
 * Turn the newest raw download of each source into normalised tables under
 * data/normalised/<source>/<snapshot id>/ (JSON arrays, CSV and snapshot.json).
 *
 *   npm run data:normalise
 *   npm run data:normalise -- --source ofac-sdn
 */
import {
  findSource,
  latestRaw,
  loadDataSources,
  normaliseRaw,
  snapshotFolder,
  writeSnapshot,
} from "@sanctions-desk/data";

const args = process.argv.slice(2);
const wanted: string[] = [];
args.forEach((arg, i) => {
  if (arg === "--source" && args[i + 1]) wanted.push(args[i + 1] as string);
});

const config = loadDataSources();
const sources = wanted.length > 0 ? wanted.map((id) => findSource(config, id)) : config.sources;

let failed = 0;
for (const source of sources) {
  const raw = latestRaw(config, source);
  if (!raw) {
    failed += 1;
    console.error(`${source.id.padEnd(20)} no raw download found; run npm run data:fetch first`);
    continue;
  }
  const started = Date.now();
  const snapshot = await normaliseRaw(source, raw);
  const dir = snapshotFolder(config, snapshot.meta);
  writeSnapshot(dir, snapshot);
  const counts = Object.entries(snapshot.meta.counts)
    .map(([table, n]) => `${table.replace("list_", "")}=${n}`)
    .join(" ");
  console.log(`${source.id.padEnd(20)} ${snapshot.meta.snapshot_id}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`${"".padEnd(20)} ${counts}`);
  console.log(`${"".padEnd(20)} ${dir}`);
}
process.exit(failed > 0 ? 1 : 0);

/**
 * Download the public sanctions lists into data/raw/<source>/<date>/ (git-ignored), with a SHA-256
 * and the fetch time recorded next to each file.
 *
 *   npm run data:fetch                       all sources
 *   npm run data:fetch -- --source un-consolidated
 *   npm run data:fetch -- --force            download again even if today's file exists
 */
import { fetchSource, findSource, loadDataSources } from "@sanctions-desk/data";

const args = process.argv.slice(2);
const force = args.includes("--force");
const wanted: string[] = [];
args.forEach((arg, i) => {
  if (arg === "--source" && args[i + 1]) wanted.push(args[i + 1] as string);
});

const config = loadDataSources();
const sources = wanted.length > 0 ? wanted.map((id) => findSource(config, id)) : config.sources;

let failed = 0;
for (const source of sources) {
  try {
    const file = await fetchSource(config, source, { force });
    console.log(
      `${source.id.padEnd(20)} ${file.reused ? "reused " : "fetched"} ${String(file.bytes).padStart(11)} bytes  sha256 ${file.sha256.slice(0, 16)}…  ${file.path}`,
    );
  } catch (err) {
    failed += 1;
    console.error(`${source.id.padEnd(20)} FAILED  ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);

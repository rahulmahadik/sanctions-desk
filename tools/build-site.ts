/**
 * Build the static API documentation site in site/: the OpenAPI document (from the API's own code, no server), the
 * architecture diagram and charts the landing page shows, and the "Recorded runs" pages (site/runs/) replayed from the
 * committed run exports; it exits 1 if a run file or receipt is missing or a receipt does not verify. The Pages
 * workflow runs the same command and publishes the
 * folder; locally, open site/index.html after it, or serve the folder with any static file server.
 *
 *   npm run site:build                   builds into site/
 *   npm run site:build -- --out <dir>    builds a complete copy (pages included) into another folder
 */
import { relative } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { RecordedRunError } from "./lib/runs-site.js";
import { buildSite } from "./lib/site.js";

const arg = (n: string, d?: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const out = arg("--out") ?? resolveProjectPath("site");
try {
  const written = buildSite(out);
  console.log(`site built in ${relative(resolveProjectPath("."), out) || "."}: ${written.join(", ")}`);
} catch (err) {
  // A missing run file or a receipt that does not verify stops the build: the pages would otherwise show a claim
  // the committed files cannot back.
  if (!(err instanceof RecordedRunError)) throw err;
  console.error(`site build stopped: ${err.message}`);
  process.exit(1);
}

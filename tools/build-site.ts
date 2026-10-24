/**
 * Build the static API documentation site in site/: the OpenAPI document (from the API's own code, no server) and the
 * architecture diagram and charts the landing page shows. The Pages workflow runs the same command and publishes the
 * folder; locally, open site/index.html after it, or serve the folder with any static file server.
 *
 *   npm run site:build                   builds into site/
 *   npm run site:build -- --out <dir>    builds a complete copy (pages included) into another folder
 */
import { relative } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { buildSite } from "./lib/site.js";

const arg = (n: string, d?: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const out = arg("--out") ?? resolveProjectPath("site");
const written = buildSite(out);
console.log(`site built in ${relative(resolveProjectPath("."), out) || "."}: ${written.join(", ")}`);

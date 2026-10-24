/**
 * Write the API's OpenAPI document to a file, from the same code the API serves at /docs/json. No server is started
 * and no service is called, so it works on a clean clone with no settings.
 *
 *   npm run openapi:export                         writes site/openapi.json
 *   npm run openapi:export -- --out api.json       writes another file
 */
import { relative } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { writeOpenApi } from "./lib/site.js";

const arg = (n: string, d?: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const file = writeOpenApi(arg("--out") ?? resolveProjectPath("site/openapi.json"));
console.log(`wrote ${relative(resolveProjectPath("."), file)}`);

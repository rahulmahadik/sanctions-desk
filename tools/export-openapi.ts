/**
 * Write the API's OpenAPI document to a file, from the same code the API serves at /docs/json. No server is started
 * and no service is called, so it works on a clean clone with no settings.
 *
 *   npm run openapi:export                         writes site/openapi.json, and the "Authentication and access"
 *                                                  section of docs/API.md from the same text
 *   npm run openapi:export -- --out api.json       writes another file
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { AUTH_GUIDE } from "../apps/api/src/auth-guide.js";
import { formatMarkdown } from "./lib/format-markdown.js";
import { writeOpenApi } from "./lib/site.js";

const arg = (n: string, d?: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const file = writeOpenApi(arg("--out") ?? resolveProjectPath("site/openapi.json"));
console.log(`wrote ${relative(resolveProjectPath("."), file)}`);

// The authentication section of docs/API.md is the same text the API description carries.
// docs/API.md is left out of Biome's checks (biome.json): Biome 2.6.2 rewrites its long route table differently
// on each run and never settles, so this formatting step is the one that applies.
const apiDoc = resolveProjectPath("docs/API.md");
const re = /<!-- auth-guide:start -->[\s\S]*?<!-- auth-guide:end -->/;
const doc = readFileSync(apiDoc, "utf8");
if (re.test(doc)) {
  writeFileSync(
    apiDoc,
    formatMarkdown(
      doc.replace(re, () => `<!-- auth-guide:start -->\n${AUTH_GUIDE}\n<!-- auth-guide:end -->`),
      apiDoc,
    ),
  );
  console.log("wrote the authentication section of docs/API.md");
}

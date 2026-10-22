/**
 * Write the Zetaris setup scripts under zetaris/sql/ from the model spec.
 *
 *   npm run zetaris:generate
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISO_COUNTRIES } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { renderScripts } from "@sanctions-desk/zetaris";

const dir = resolveProjectPath("zetaris/sql");
mkdirSync(dir, { recursive: true });
const scripts = renderScripts({ isoCodes: ISO_COUNTRIES.map(([iso2]) => iso2) });
for (const old of readdirSync(dir).filter((f) => f.endsWith(".sql") && !(f in scripts))) rmSync(join(dir, old));
for (const [name, text] of Object.entries(scripts)) writeFileSync(join(dir, name), text);
console.log(`wrote ${Object.keys(scripts).length} scripts to zetaris/sql/`);

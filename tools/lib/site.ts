/**
 * The static API documentation site (site/): the OpenAPI document the API serves at /docs/json, written to a file
 * without starting a server or calling any service, the images the landing page shows, and the "Recorded runs"
 * pages (runs/, from the committed run exports; see runs-site.ts) and the receipt log (receipts/, every model call
 * with its checked receipt; see receipt-log.ts). The landing and API pages are committed; what is
 * generated here is git-ignored and rebuilt by `npm run site:build`, so it never goes stale.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { buildOpenApi } from "../../apps/api/src/openapi.js";
import { buildReceiptLog } from "./receipt-log.js";
import { buildRunPages } from "./runs-site.js";

/** The committed pages of the site, copied when the site is built somewhere other than site/. */
export const SITE_PAGES = ["index.html", "api.html"] as const;

/** Each image the landing page shows: its path in the built site and the repository file it is copied from. */
export const SITE_IMAGES: Record<string, string> = {
  "media/architecture.png": "docs/media/architecture.png",
  "media/charts/heldout-wrong-closes.png": "docs/media/charts/heldout-wrong-closes.png",
  "media/charts/first-recommendation-closes.png": "docs/media/charts/first-recommendation-closes.png",
  "media/charts/critic-mutation.png": "docs/media/charts/critic-mutation.png",
  "media/charts/model-calls.png": "docs/media/charts/model-calls.png",
  "media/charts/model-latency.png": "docs/media/charts/model-latency.png",
};

/** The API's version, as its package states it. */
export function apiVersion(): string {
  return (JSON.parse(readFileSync(resolveProjectPath("apps/api/package.json"), "utf8")) as { version: string }).version;
}

/** The OpenAPI document, built by the same code the API uses for /docs/json. */
export function openApiDocument(): Record<string, unknown> {
  return buildOpenApi(apiVersion()) as Record<string, unknown>;
}

/** Write the OpenAPI document as formatted JSON. Returns the file written. */
export function writeOpenApi(file: string): string {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
  return path;
}

/**
 * Build the site into `outDir` (site/ by default): the OpenAPI document and the images, plus the pages when the
 * folder is not site/ itself. Returns the files written, relative to `outDir`.
 */
export function buildSite(outDir = resolveProjectPath("site")): string[] {
  const out = resolve(outDir);
  const source = resolveProjectPath("site");
  const written: string[] = [];
  if (out !== resolve(source)) {
    mkdirSync(out, { recursive: true });
    for (const page of SITE_PAGES) {
      copyFileSync(join(source, page), join(out, page));
      written.push(page);
    }
  }
  writeOpenApi(join(out, "openapi.json"));
  written.push("openapi.json");
  for (const [target, from] of Object.entries(SITE_IMAGES)) {
    mkdirSync(dirname(join(out, target)), { recursive: true });
    copyFileSync(resolveProjectPath(from), join(out, target));
    written.push(target);
  }
  for (const f of buildRunPages(join(out, "runs"))) written.push(`runs/${f}`);
  for (const f of buildReceiptLog(join(out, "receipts"))) written.push(`receipts/${f}`);
  return written;
}

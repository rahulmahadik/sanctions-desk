/**
 * The static API documentation site (site/): the OpenAPI document (built without starting a server), the landing
 * page images, the recorded runs (runs-site.ts), the receipt log (receipt-log.ts) and the results page
 * (results-page.ts). The landing, architecture and API pages and the stylesheet are committed; the landing page's
 * figures are filled in from the committed data on every build (site-facts.ts). Everything else generated here is
 * git-ignored and rebuilt by `npm run site:build`, so it never goes stale.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { buildOpenApi } from "../../apps/api/src/openapi.js";
import { buildReceiptLog } from "./receipt-log.js";
import { buildResultsPage } from "./results-page.js";
import { buildRunPages } from "./runs-site.js";
import { FONT_FILES } from "./site-chrome.js";
import { fillIndex, siteFacts } from "./site-facts.js";

/** The committed pages of the site, copied when the site is built somewhere other than site/. */
export const SITE_PAGES = ["index.html", "api.html", "architecture.html"] as const;
/** The committed assets the pages load: the stylesheet, the home page's one small script, the fonts, Redoc. */
export const SITE_ASSETS = [
  "site.css",
  "site.js",
  ...FONT_FILES,
  "vendor/redoc/redoc.standalone.js",
  "vendor/redoc/redoc.standalone.js.LICENSE.txt",
  "vendor/redoc/LICENSE-redoc.txt",
] as const;

/** Each image the landing page shows: its path in the built site and the repository file it is copied from. */
export const SITE_IMAGES: Record<string, string> = {
  ...Object.fromEntries(
    [
      "1-architecture",
      "2-review-sequence",
      "3-fail-closed",
      "4-alert-lifecycle",
      "5-data-privacy",
      "6-zetaris-access",
    ].map((n) => [`media/diagrams/${n}.svg`, `docs/diagrams/${n}.svg`]),
  ),
  "media/video-thumbnail.png": "docs/media/video-thumbnail.png",
  ...Object.fromEntries(
    ["09-risk-signals", "16-live-model-per-step", "17-live-decision-panel"].map((n) => [
      `media/screenshots/${n}.png`,
      `docs/media/screenshots/${n}.png`,
    ]),
  ),
  "media/sanctions-desk-deck.pdf": "docs/sanctions-desk-deck.pdf",
  "media/charts/heldout-wrong-closes.png": "docs/media/charts/heldout-wrong-closes.png",
  "media/charts/first-recommendation-closes.png": "docs/media/charts/first-recommendation-closes.png",
  "media/charts/critic-mutation.png": "docs/media/charts/critic-mutation.png",
  "media/charts/model-calls.png": "docs/media/charts/model-calls.png",
  "media/charts/model-latency.png": "docs/media/charts/model-latency.png",
  "media/charts/model-choice.png": "docs/media/charts/model-choice.png",
  "media/charts/repeat-study.png": "docs/media/charts/repeat-study.png",
};

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

/** The landing page with its figures filled in from the committed data under `root`. */
export function renderIndex(root = resolveProjectPath(".")): string {
  return fillIndex(readFileSync(join(root, "site", "index.html"), "utf8"), siteFacts(root));
}

/**
 * Build the site into `outDir` (site/ by default): the OpenAPI document and the images, the landing page with its
 * figures filled in, plus the other committed pages and the stylesheet when the folder is not site/ itself. Returns
 * the files written, relative to `outDir`.
 */
export function buildSite(outDir = resolveProjectPath("site")): string[] {
  const out = resolve(outDir);
  const source = resolveProjectPath("site");
  const written: string[] = [];
  mkdirSync(out, { recursive: true });
  // Filled in place when building site/ itself: the markers stay, so the committed page carries the current figures.
  writeFileSync(join(out, "index.html"), renderIndex());
  written.push("index.html");
  if (out !== resolve(source)) {
    for (const f of [...SITE_PAGES.filter((p) => p !== "index.html"), ...SITE_ASSETS]) {
      mkdirSync(dirname(join(out, f)), { recursive: true });
      copyFileSync(join(source, f), join(out, f));
      written.push(f);
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
  written.push(buildResultsPage(out));
  return written;
}

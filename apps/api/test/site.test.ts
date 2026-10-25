import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSite,
  openApiDocument,
  renderIndex,
  SITE_ASSETS,
  SITE_IMAGES,
  SITE_PAGES,
} from "../../../tools/lib/site.js";
import { FONT_FILES, NAV_LINKS } from "../../../tools/lib/site-chrome.js";
import { fillIndex, SiteFactsError, siteFacts } from "../../../tools/lib/site-facts.js";
import { ROUTES } from "../src/openapi.js";

const REPO_URL = "https://github.com/rahulmahadik/sanctions-desk";
const REPO_BLOB = `${REPO_URL}/blob/main/`;
/** Outside links a page may carry besides the repository: the demo video (a link only; nothing is loaded from it). */
const EXTERNAL_OK: string[] = ["https://youtu.be/cF4ZXKxjpxs"];
const out = mkdtempSync(join(tmpdir(), "desk-site-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

type Operation = {
  summary?: string;
  responses?: Record<string, unknown>;
  parameters?: Array<{ name: string; in: string }>;
};
const doc = openApiDocument() as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
};

/** Every href and src in a page. */
const linksOf = (html: string) => [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1] as string);
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: resolveProjectPath("."), encoding: "utf8" }).split("\0"),
);
/** Every .html file under `dir`, relative to it. */
function htmlFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return htmlFiles(p, base);
    return d.name.endsWith(".html") ? [relative(base, p)] : [];
  });
}

describe("the self-hosted Redoc bundle", () => {
  it("is the pinned 2.5.4 bundle, checked by the same integrity hash, with its MIT licence", () => {
    const api = readFileSync(resolveProjectPath("site/api.html"), "utf8");
    const integrity = /src="vendor\/redoc\/redoc\.standalone\.js"\s+integrity="([^"]+)"/.exec(api)?.[1];
    const bundle = readFileSync(resolveProjectPath("site/vendor/redoc/redoc.standalone.js"));
    expect(integrity).toBe(`sha384-${createHash("sha384").update(bundle).digest("base64")}`);
    expect(readFileSync(resolveProjectPath("site/vendor/redoc/LICENSE-redoc.txt"), "utf8")).toContain("MIT License");
  });

  it("keeps a self-only content policy on the API page, which stops Redoc's one outside image (its logo)", () => {
    const api = readFileSync(resolveProjectPath("site/api.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(api)?.[1] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toMatch(/https?:/);
  });
});

describe("the self-hosted fonts", () => {
  it("ships every font file with its OFL licence, and the stylesheet points at them", () => {
    for (const f of FONT_FILES) expect(existsSync(resolveProjectPath(`site/${f}`)), f).toBe(true);
    const css = readFileSync(resolveProjectPath("site/site.css"), "utf8");
    for (const f of FONT_FILES.filter((x) => x.endsWith(".woff2"))) expect(css).toContain(`url("${f}")`);
    expect(readFileSync(resolveProjectPath("site/fonts/OFL-Inter.txt"), "utf8")).toContain("SIL Open Font License");
  });
});

describe("the exported OpenAPI document", () => {
  it("is an OpenAPI 3.1 document with a title, a version and every documented route", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Sanctions Desk API");
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const route of ROUTES)
      expect(doc.paths[route.path]?.[route.method], `${route.method} ${route.path}`).toBeTruthy();
    expect(Object.values(doc.paths).flatMap((p) => Object.keys(p)).length).toBe(ROUTES.length);
  });

  it("gives every operation a summary and responses, and declares every path parameter", () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries(ops)) {
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
        const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
        expect(declared.sort(), `${method} ${path}`).toEqual([...inPath].sort());
      }
    }
  });

  it("survives a JSON round trip unchanged (nothing in it that a file cannot hold)", () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

describe("the documentation site", () => {
  const written = buildSite(out);
  const pages = htmlFiles(out);
  const html = (f: string) => readFileSync(join(out, f), "utf8");

  it("builds the pages, the stylesheet, the OpenAPI document and the images", () => {
    for (const f of [...SITE_PAGES, ...SITE_ASSETS, "openapi.json", ...Object.keys(SITE_IMAGES)]) {
      expect(written).toContain(f);
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    for (const l of NAV_LINKS) expect(existsSync(join(out, l.path)), l.path).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "openapi.json"), "utf8"))).toEqual(doc);
    expect(pages.length).toBeGreaterThan(10);
  });

  it("gives every page the one stylesheet, the top bar with every section, the footer and the theme colour", () => {
    for (const page of pages) {
      const text = html(page);
      const up = page.includes("/") ? "../" : "";
      expect(text, page).toContain(`href="${up}site.css"`);
      expect(text, page).toContain("fonts/inter-latin-variable.woff2");
      expect(text, page).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(text, page).toContain('<meta name="theme-color" content="#0b1a2e" />');
      expect(text, page).toContain('<meta name="color-scheme" content="light dark" />');
      expect(text, page).toContain('class="topbar"');
      expect(text, page).toContain('class="site-footer"');
      for (const l of NAV_LINKS) expect(text, `${page}: ${l.label}`).toContain(`href="${up}${l.path}"`);
      expect(text, page).toContain(`href="${REPO_URL}"`);
      expect(text, page).not.toMatch(/<style[\s>]/);
    }
  });

  it("has only links that resolve: relative ones in the built site, repository ones to tracked files", () => {
    let checked = 0;
    for (const page of pages) {
      const text = html(page);
      for (const link of linksOf(text)) {
        checked += 1;
        if (link.startsWith(REPO_BLOB)) {
          expect(tracked.has(link.slice(REPO_BLOB.length).split("#")[0] ?? ""), `${page}: ${link}`).toBe(true);
        } else if (/^[a-z]+:/i.test(link)) {
          expect(
            link === REPO_URL || EXTERNAL_OK.some((p) => link.startsWith(p)),
            `${page}: ${link} is loaded from outside`,
          ).toBe(true);
        } else if (link.startsWith("#")) {
          expect(text, `${page}: ${link}`).toContain(`id="${link.slice(1)}"`);
        } else {
          const target = resolve(join(out, dirname(page)), link.split("#")[0] as string);
          expect(existsSync(target), `${page}: ${link}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("loads only its own hash-checked copy of Redoc, nothing from outside, and calls no API", () => {
    const api = html("api.html");
    const scripts = [...api.matchAll(/<script\s[^>]*src="([^"]+)"[^>]*>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toBe("vendor/redoc/redoc.standalone.js");
    expect(existsSync(join(out, "vendor/redoc/redoc.standalone.js"))).toBe(true);
    expect(scripts[0]?.[0]).toMatch(/integrity="sha384-/);
    for (const page of pages) {
      const text = html(page);
      expect(text, page).not.toMatch(/localhost|127\.0\.0\.1|fetch\(/);
      if (page !== "api.html") expect(text, page).not.toMatch(/<script|<iframe/);
      for (const m of text.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g))
        expect(/^(\.\.\/)?site\.css$/.test(m[1] as string), `${page}: ${m[1]}`).toBe(true);
    }
  });

  it("fills the landing page's figures from the committed data, and the committed page carries them", () => {
    const facts = siteFacts(resolveProjectPath("."));
    expect(facts.full_wrong).toMatch(/^\d+ of \d+$/);
    expect(facts.alone_wrong).toMatch(/^\d+ of \d+$/);
    expect(facts.receipts).toMatch(/^\d{1,3}(,\d{3})*$/);
    expect(Number(facts.step_roles)).toBeGreaterThan(0);
    const built = html("index.html");
    for (const [name, value] of Object.entries(facts))
      expect(built, name).toContain(`<!--fact:${name}-->${value}<!--/fact-->`);
    // The step-to-model card names each step with the badge of the model that serves it.
    expect(built).toContain('<span class="badge badge-local">Nemotron 3.5 Lightning · local</span>');
    expect(built).toContain('<span class="badge badge-cloud">Nemotron 3 Ultra · cloud</span>');
    expect(built).toContain('<span class="badge badge-backup">Ollama · backup, no receipt</span>');
    // The committed site/index.html is the filled page, so a reader of the repository sees the same figures.
    expect(renderIndex()).toBe(readFileSync(resolveProjectPath("site/index.html"), "utf8"));
    // An unknown marker, or a page without markers, stops the build.
    expect(() => fillIndex("<!-- steps:start --><!-- steps:end --><!--fact:nope-->1<!--/fact-->", facts)).toThrow(
      SiteFactsError,
    );
    expect(() => fillIndex("<!-- steps:start --><!-- steps:end -->", facts)).toThrow(/no <!--fact/);
  });
});

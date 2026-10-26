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
import { FONT_FILES, FOOTER_LINKS, NAV_LINKS } from "../../../tools/lib/site-chrome.js";
import { fillIndex, SiteFactsError, siteFacts, storyLinksHtml } from "../../../tools/lib/site-facts.js";
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
    for (const l of [...NAV_LINKS, ...FOOTER_LINKS]) expect(existsSync(join(out, l.path)), l.path).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "openapi.json"), "utf8"))).toEqual(doc);
    expect(pages.length).toBeGreaterThan(10);
  });

  it("keeps the top bar to five sections, so it fits one row on a phone; the API and GitHub links are in the footer", () => {
    expect(NAV_LINKS.length).toBeLessThanOrEqual(5);
    expect(NAV_LINKS.map((l) => l.path)).not.toContain("api.html");
    for (const page of pages) {
      const text = html(page);
      const up = page.includes("/") ? "../" : "";
      const bar = /<header class="topbar"[\s\S]*?<\/header>/.exec(text)?.[0] ?? "";
      const foot = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(text)?.[0] ?? "";
      expect(bar, page).not.toContain(REPO_URL);
      expect(bar.match(/<li>/g)?.length, page).toBe(NAV_LINKS.length);
      for (const l of FOOTER_LINKS) expect(foot, `${page}: ${l.label}`).toContain(`href="${up}${l.path}"`);
      expect(foot, page).toContain(`href="${REPO_URL}"`);
    }
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
      // No page carries a player: the home page's script makes the video's frame only when play is pressed.
      expect(text, page).not.toMatch(/<iframe/);
      if (page === "index.html") {
        // The home page loads one script, the site's own site.js, and runs nothing inline.
        const tags = [...text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
        expect(tags, page).toEqual(['<script src="site.js" defer>']);
      } else if (page !== "api.html") expect(text, page).not.toMatch(/<script/);
      for (const m of text.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g))
        expect(/^(\.\.\/)?site\.css$/.test(m[1] as string), `${page}: ${m[1]}`).toBe(true);
    }
  });

  it("keeps the home page's content policy to the site itself, with the video's player frame the only outside origin", () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html("index.html"))?.[1] ?? "";
    const directives = Object.fromEntries(
      csp.split(";").map((d) => {
        const [name, ...sources] = d.trim().split(/\s+/);
        return [name as string, sources];
      }),
    );
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["img-src"]).toEqual(["'self'", "data:"]);
    expect(directives["frame-src"]).toEqual(["https://www.youtube-nocookie.com"]);
    expect(csp).not.toMatch(/unsafe-|\*/);
    expect(csp.match(/https?:\/\/[^\s;]+/g)).toEqual(["https://www.youtube-nocookie.com"]);
    // style-src 'self' would drop inline styles, so the page has none.
    expect(html("index.html")).not.toMatch(/\sstyle="/);
  });

  it("ships a small script that loads nothing but the video's player, and only from youtube-nocookie.com", () => {
    const js = readFileSync(join(out, "site.js"), "utf8");
    expect(js.length).toBeLessThan(4000);
    expect(js.match(/https?:\/\/[^\s"'`]+/g)).toEqual(["https://www.youtube-nocookie.com/embed/"]);
    expect(js).not.toMatch(
      /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(|\beval\(|innerHTML|document\.write|localStorage/,
    );
    expect(js).toContain('createElement("iframe")');
    // Without the script the thumbnail and the hero's button are plain links to the video, opening in a new tab.
    expect(html("index.html")).toMatch(
      /<a\s+class="video-link"\s+href="https:\/\/youtu\.be\/cF4ZXKxjpxs"\s+target="_blank"\s+rel="noopener noreferrer"/,
    );
    expect(html("index.html")).toMatch(
      /<a class="btn btn-primary" href="https:\/\/youtu\.be\/cF4ZXKxjpxs" target="_blank" rel="noopener noreferrer" data-play="cF4ZXKxjpxs">/,
    );
    // With it, both play the video in place: the button plays the thumbnail's video.
    expect(js).toContain('a[data-play="${id}"]');
  });

  it("gives the hero two buttons, with the other ways in as a row of text links", () => {
    const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(html("index.html"))?.[0] ?? "";
    expect(hero.match(/class="btn /g)).toHaveLength(2);
    expect(hero).toContain("Watch the demo (3:51)");
    expect(hero).toContain('href="results.html">See the results</a>');
    for (const href of ["runs/index.html", "receipts/index.html", "media/sanctions-desk-deck.pdf"])
      expect(hero, href).toMatch(new RegExp(`<ul class="more-links">[\\s\\S]*href="${href}"`));
    expect(hero).toContain(
      "A prototype, audit-ready by design: synthetic customers and payments, public list entries, not in production.",
    );
    // The note about youtube-nocookie.com is said once on the page.
    expect(html("index.html").match(/youtube-nocookie\.com/g)).toHaveLength(2); // the content policy and the caption
  });

  it("shows the role cards' cropped details, each opening the full screenshot", () => {
    const home = html("index.html");
    for (const [full, detail] of [
      ["09-risk-signals", "09-risk-signals-detail"],
      ["17-live-decision-panel", "17-decision-panel-detail"],
      ["16-live-model-per-step", "16-model-per-step-detail"],
    ]) {
      expect(home).toMatch(
        new RegExp(
          `<a class="role-shot" href="media/screenshots/${full}\\.png"[^>]*>\\s*<img\\s+src="media/screenshots/${detail}\\.png"`,
        ),
      );
      expect(SITE_IMAGES[`media/screenshots/${detail}.png`]).toBe(`docs/media/screenshots/${detail}.png`);
    }
  });

  it("shows two charts on the home page and leaves the rest to the results page", () => {
    const home = html("index.html");
    const charts = [...home.matchAll(/<img\s+src="media\/charts\/([\w-]+)\.png"/g)].map((m) => m[1]);
    expect(charts).toEqual(["heldout-wrong-closes", "model-calls"]);
    expect(home).toContain('<a href="results.html">Every chart and table on the results page</a>');
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
    // The story card links to the result files behind its figures: both Nemotron-alone runs and the newest desk run.
    const links = storyLinksHtml(resolveProjectPath("."));
    expect(built).toContain(links);
    const files = [...links.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] as string).slice(REPO_BLOB.length));
    expect(files).toHaveLength(3);
    expect(files.filter((f) => /nemotron_alone\.json$/.test(f))).toHaveLength(2);
    for (const f of files) expect(tracked.has(f), f).toBe(true);
    expect(built).toContain('href="runs/alr-0073.html"');
    expect(facts.story_alone_conf).toMatch(/^0\.\d\d$/);
    expect(facts.story_desk_runs).toMatch(/^(\d+) of \1$/);
  });
});

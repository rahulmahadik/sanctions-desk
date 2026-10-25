import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite, openApiDocument, SITE_IMAGES, SITE_PAGES } from "../../../tools/lib/site.js";
import { ROUTES } from "../src/openapi.js";

const REPO_BLOB = "https://github.com/rahulmahadik/sanctions-desk/blob/main/";
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

  it("builds the pages, the OpenAPI document and the images", () => {
    for (const f of [...SITE_PAGES, "openapi.json", ...Object.keys(SITE_IMAGES)]) {
      expect(written).toContain(f);
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(out, "openapi.json"), "utf8"))).toEqual(doc);
  });

  it("has only links that resolve: relative ones in the built site, repository ones to tracked files", () => {
    for (const page of SITE_PAGES) {
      for (const link of linksOf(readFileSync(join(out, page), "utf8"))) {
        if (link.startsWith(REPO_BLOB)) {
          expect(tracked.has(link.slice(REPO_BLOB.length).split("#")[0] ?? ""), `${page}: ${link}`).toBe(true);
        } else if (!/^[a-z]+:/i.test(link)) {
          expect(existsSync(join(out, link.split("#")[0] as string)), `${page}: ${link}`).toBe(true);
        }
      }
    }
  });

  it("loads only a pinned, hash-checked script from outside and calls no API", () => {
    const api = readFileSync(join(out, "api.html"), "utf8");
    const scripts = [...api.matchAll(/<script\s[^>]*src="([^"]+)"[^>]*>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/redoc@\d+\.\d+\.\d+\//);
    expect(scripts[0]?.[0]).toMatch(/integrity="sha384-/);
    for (const page of SITE_PAGES) {
      const html = readFileSync(join(out, page), "utf8");
      expect(html, page).not.toMatch(/localhost|127\.0\.0\.1|fetch\(|fonts\.googleapis/);
    }
  });
});

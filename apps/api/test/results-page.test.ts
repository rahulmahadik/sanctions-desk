import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  blockOf,
  inline,
  RESULTS_SECTIONS,
  ResultsPageError,
  renderBlock,
  renderResultsPage,
} from "../../../tools/lib/results-page.js";
import { REPO_URL } from "../../../tools/lib/runs-site.js";

const scratch = mkdtempSync(join(tmpdir(), "desk-results-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the documents the page reads, so one can be changed without touching the repository. */
function docsCopy(): string {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const doc of new Set(RESULTS_SECTIONS.flatMap((s) => s.blocks.map((b) => b.doc)))) {
    mkdirSync(join(root, doc, ".."), { recursive: true });
    cpSync(resolveProjectPath(doc), join(root, doc));
  }
  return root;
}

describe("the results page", () => {
  const html = renderResultsPage();
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("has every section, and every number of every block it copies", () => {
    for (const s of RESULTS_SECTIONS) {
      expect(html).toContain(`>${s.title}</h2>`);
      for (const b of s.blocks) {
        const block = blockOf(resolveProjectPath("."), b.doc, b.marker);
        // Every figure in the generated block appears on the page.
        for (const n of new Set(block.match(/\b\d+(?:\.\d+)? of \d+\b/g) ?? [])) expect(text(html)).toContain(n);
      }
    }
  });

  it("links relative paths to the files on GitHub", () => {
    expect(inline("docs/NEMOTRON.md", "[MODELS.md](MODELS.md#x)")).toBe(
      `<a href="${REPO_URL}/blob/main/docs/MODELS.md#x">MODELS.md</a>`,
    );
    expect(inline("README.md", "[r](eval/REPORT.md)")).toContain(`${REPO_URL}/blob/main/eval/REPORT.md`);
  });

  it("escapes text and renders tables with right-aligned number columns", () => {
    const out = renderBlock("README.md", "| a | n |\n| --- | ---: |\n| <b> | 3 |");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain('<td class="num">3</td>');
  });

  it("stops the build when a block is missing or empty", () => {
    const root = docsCopy();
    const doc = join(root, "docs/NEMOTRON.md");
    writeFileSync(
      doc,
      readFileSync(doc, "utf8").replace(
        /<!-- model-choice:start -->[\s\S]*?<!-- model-choice:end -->/,
        "<!-- model-choice:start -->\n<!-- model-choice:end -->",
      ),
    );
    expect(() => renderResultsPage(root)).toThrow(ResultsPageError);
    writeFileSync(
      doc,
      readFileSync(doc, "utf8").replace(/<!-- model-choice:start -->[\s\S]*?<!-- model-choice:end -->/, ""),
    );
    expect(() => renderResultsPage(root)).toThrow(/no model-choice block/);
  });
});

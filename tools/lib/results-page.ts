/**
 * The results page of the static site (site/results.html). It copies the generated blocks (between <!-- name:start -->
 * and <!-- name:end --> markers) out of README.md, docs/EVALUATION.md and docs/NEMOTRON.md, so the page and the docs
 * can never disagree. Nothing on the page is typed in by hand.
 *
 * The build stops (throws ResultsPageError) when a document or one of its blocks is missing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { esc, REPO_URL } from "./runs-site.js";

export class ResultsPageError extends Error {}

/** One section of the page: a heading, a short lead and the generated blocks it shows, in order. */
export interface ResultsSection {
  title: string;
  lead: string;
  blocks: Array<{ doc: string; marker: string }>;
  image?: { src: string; alt: string };
}

export const RESULTS_SECTIONS: readonly ResultsSection[] = [
  {
    title: "Headline",
    lead: "The summary at the top of the README.",
    blocks: [{ doc: "README.md", marker: "headline" }],
  },
  {
    title: "Every held-out round, as run",
    lead: "Wrong closes stay in the table. The held-out sets are cases the rules were not written for.",
    blocks: [
      { doc: "README.md", marker: "rounds" },
      { doc: "docs/EVALUATION.md", marker: "round-story" },
    ],
    image: {
      src: "media/charts/heldout-wrong-closes.png",
      alt: "Bar chart: risk cases wrongly closed in each held-out round, for the full system and three simpler baselines.",
    },
  },
  {
    title: "Nemotron scorecard",
    lead: "Which model does each step and where, what each model did in the recorded runs, calibration and the safety guard.",
    blocks: [{ doc: "docs/NEMOTRON.md", marker: "nemotron-scorecard" }],
  },
  {
    title: "What the agents add over Nemotron alone",
    lead: "Small studies, kept apart from the recorded evaluation.",
    blocks: [
      { doc: "docs/NEMOTRON.md", marker: "alone-headline" },
      { doc: "docs/NEMOTRON.md", marker: "repeat-study" },
      { doc: "docs/NEMOTRON.md", marker: "alone-sets" },
      { doc: "docs/NEMOTRON.md", marker: "v3-today" },
    ],
  },
  {
    title: "Why two Nemotron models",
    lead: "The same cases with the reasoning steps on Ultra in the cloud or on Lightning on the laptop.",
    blocks: [{ doc: "docs/NEMOTRON.md", marker: "model-choice" }],
    image: {
      src: "media/charts/model-choice.png",
      alt: "Chart: reasoning steps on Ultra in the cloud or Lightning locally.",
    },
  },
  {
    title: "Safety guard against injected text",
    lead: "The local guard model and the fixed patterns on texts written to attack the reviewer: the guard alone (asked once), the same texts through full reviews (guard asked once), and a fresh set on the current guard (asked twice, plus a narrow check). Misses are listed.",
    blocks: [
      { doc: "docs/EVALUATION.md", marker: "adversarial" },
      { doc: "docs/EVALUATION.md", marker: "adversarial-review" },
      { doc: "docs/EVALUATION.md", marker: "adversarial-fresh" },
    ],
  },
  {
    title: "Receipt statistics",
    lead: "Every model call per step and per model that served it, from the traces and the signed receipts.",
    blocks: [{ doc: "docs/NEMOTRON.md", marker: "receipt-stats" }],
    image: { src: "media/charts/model-latency.png", alt: "Chart: time per model call, by step and model." },
  },
];

/** The text of one generated block, without its markers. */
export function blockOf(root: string, doc: string, marker: string): string {
  const path = join(root, doc);
  if (!existsSync(path)) throw new ResultsPageError(`${doc} is missing`);
  const text = readFileSync(path, "utf8");
  const m = text.match(new RegExp(`<!-- ${marker}:start -->([\\s\\S]*?)<!-- ${marker}:end -->`));
  if (!m?.[1]?.trim()) throw new ResultsPageError(`${doc} has no ${marker} block, or it is empty`);
  return m[1].trim();
}

/** A link in a document, made absolute: relative paths point at the file on GitHub, resolved from the document. */
function href(doc: string, target: string): string {
  if (/^(https?:|mailto:)/.test(target)) return target;
  const [path, anchor] = target.split("#");
  const resolved = path ? posix.normalize(posix.join(posix.dirname(doc), path)) : doc;
  return `${REPO_URL}/blob/main/${resolved}${anchor ? `#${anchor}` : ""}`;
}

/** Inline Markdown the generated blocks use: code, bold, italics and links. Everything else is escaped text. */
export function inline(doc: string, text: string): string {
  const parts = text.split(/(`[^`]*`)/);
  return parts
    .map((p) => {
      if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, target: string) => {
          return `<a href="${esc(href(doc, target.replace(/&amp;/g, "&")))}">${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    })
    .join("");
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** A Markdown table (header, alignment row, body) as HTML; right-aligned columns get the "num" class. */
function renderTable(doc: string, rows: string[]): string {
  const [head, align, ...body] = rows;
  const numeric = cells(align ?? "").map((c) => c.endsWith(":"));
  const cell = (c: string, j: number, tag: "th" | "td") =>
    `<${tag}${numeric[j] ? ' class="num"' : ""}${tag === "th" ? ' scope="col"' : ""}>${inline(doc, c)}</${tag}>`;
  const row = (r: string, tag: "th" | "td") =>
    `<tr>${cells(r)
      .map((c, j) => cell(c, j, tag))
      .join("")}</tr>`;
  return `<div class="wrap" role="region" tabindex="0"><table><thead>${row(head ?? "", "th")}</thead><tbody>${body
    .map((r) => row(r, "td"))
    .join("")}</tbody></table></div>`;
}

/** The Markdown of a generated block as HTML: paragraphs, bullet lists and tables. */
export function renderBlock(doc: string, md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i += 1;
    } else if (line.trim().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] as string).trim().startsWith("|")) rows.push(lines[i++] as string);
      out.push(renderTable(doc, rows));
    } else if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i] as string)) items.push((lines[i++] as string).slice(2));
      out.push(`<ul>${items.map((x) => `<li>${inline(doc, x)}</li>`).join("")}</ul>`);
    } else {
      const para: string[] = [];
      while (i < lines.length && (lines[i] as string).trim() && !/^(\||- )/.test((lines[i] as string).trim()))
        para.push(lines[i++] as string);
      out.push(`<p>${inline(doc, para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

const CSS = `* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #f6f7f9; color: #16181d; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.8rem; margin: 8px 0; }
h2 { font-size: 1.25rem; margin: 36px 0 8px; }
p, ul { margin: 0 0 12px; }
a { color: #1d4ed8; }
a:focus-visible, .wrap:focus-visible { outline: 3px solid #d97706; outline-offset: 2px; }
code { font: 0.85em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.banner { background: #fff7e6; border: 1px solid #f0c36d; border-radius: 8px; padding: 10px 14px; }
.lead, .muted { color: #4b5563; }
.wrap { max-width: 100%; overflow-x: auto; background: #fff; border: 1px solid #d9dde3; border-radius: 8px; margin: 0 0 12px; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px; border-top: 1px solid #e5e7eb; }
th { background: #f3f4f6; }
.num { text-align: right; white-space: nowrap; }
figure { margin: 0 0 16px; background: #fff; border: 1px solid #d9dde3; border-radius: 8px; padding: 12px; }
figure img { display: block; width: 100%; height: auto; }
footer { margin-top: 40px; color: #4b5563; font-size: 0.9rem; }
`;

export function renderResultsPage(root = resolveProjectPath(".")): string {
  const sections = RESULTS_SECTIONS.map((s) => {
    const blocks = s.blocks.map((b) => renderBlock(b.doc, blockOf(root, b.doc, b.marker))).join("\n");
    const img = s.image
      ? `<figure><img src="${esc(s.image.src)}" alt="${esc(s.image.alt)}" loading="lazy" /></figure>`
      : "";
    const id = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `<section aria-labelledby="${id}"><h2 id="${id}">${esc(s.title)}</h2><p class="lead">${esc(s.lead)}</p>\n${blocks}\n${img}</section>`;
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Sanctions Desk results</title>
    <style>${CSS}</style>
  </head>
  <body>
    <main>
      <p class="banner" role="note"><strong>Results as recorded.</strong> Every table on this page is copied from a block
      that a script writes into the <a href="${REPO_URL}">repository</a>'s README and docs from the committed result
      files; nothing here is typed in by hand. Every figure is one run unless it says otherwise.</p>
      <h1>Results</h1>
      <p class="muted">Customers and payments are synthetic; listed parties are public sanctions-list entries. Recorded
      runs step by step: <a href="runs/index.html">recorded runs</a>; every model call and its receipt:
      <a href="receipts/index.html">receipt log</a>.</p>
${sections.join("\n")}
      <footer><a href="index.html">Site home</a> · <a href="${REPO_URL}">Source on GitHub</a> (Apache-2.0)</footer>
    </main>
  </body>
</html>
`;
}

/** Write site/results.html (or `<outDir>/results.html`). Returns the file written, relative to `outDir`. */
export function buildResultsPage(outDir: string, root = resolveProjectPath(".")): string {
  writeFileSync(join(outDir, "results.html"), renderResultsPage(root));
  return "results.html";
}

/**
 * The results page of the static site (site/results.html). It copies the generated blocks (between <!-- name:start -->
 * and <!-- name:end --> markers) out of README.md, docs/EVALUATION.md and docs/NEMOTRON.md, so the page and the docs
 * can never disagree. Nothing on the page is typed in by hand.
 *
 * The five-line headline at the top is written from the home page's generated facts (site-facts.ts), so the two pages
 * quote the same figures.
 *
 * The build stops (throws ResultsPageError) when a document or one of its blocks is missing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { esc, pageOf, REPO_URL } from "./site-chrome.js";
import { siteFacts } from "./site-facts.js";

export class ResultsPageError extends Error {}

/** One section of the page: a heading, a short lead and the generated blocks it shows, in order. */
export interface ResultsSection {
  title: string;
  lead: string;
  blocks: Array<{ doc: string; marker: string }>;
  images?: Array<{ src: string; alt: string }>;
}

export const RESULTS_SECTIONS: readonly ResultsSection[] = [
  {
    title: "Headline",
    lead: "The summary at the top of the README.",
    blocks: [
      { doc: "README.md", marker: "results-box" },
      { doc: "README.md", marker: "headline" },
    ],
  },
  {
    title: "Every held-out round, as run",
    lead: "Wrong closes stay in the table. The held-out sets are cases the rules were not written for.",
    blocks: [
      { doc: "README.md", marker: "rounds" },
      { doc: "docs/EVALUATION.md", marker: "round-story" },
    ],
    images: [
      {
        src: "media/charts/heldout-wrong-closes.png",
        alt: "Bar chart: risk cases wrongly closed in each held-out round, for the full system and three simpler baselines.",
      },
    ],
  },
  {
    title: "What the critic and challenger did",
    lead: "From the traces of the recorded runs and the mutation test: the closes the checks stopped, and where the critic hurt.",
    blocks: [{ doc: "docs/EVALUATION.md", marker: "critic-value" }],
    images: [
      {
        src: "media/charts/first-recommendation-closes.png",
        alt: "Chart: per run, how often the decision step first proposed closing a risk case, and how many of those the checks stopped.",
      },
      {
        src: "media/charts/critic-mutation.png",
        alt: "Chart: the critic's fact re-check, changed facts caught and unchanged decisions approved.",
      },
    ],
  },
  {
    title: "Nemotron scorecard",
    lead: "Which model does each step and where, what each model did in the recorded runs, calibration and the safety guard.",
    blocks: [{ doc: "docs/NEMOTRON.md", marker: "nemotron-scorecard" }],
    images: [
      {
        src: "media/charts/model-calls.png",
        alt: "Chart: which Nemotron model served each review step in the current system's newest 70-case run, and the signed receipts verified.",
      },
    ],
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
    images: [
      {
        src: "media/charts/repeat-study.png",
        alt: "Chart: held-out v4, three runs each, the full system and Nemotron alone without and with the free text.",
      },
    ],
  },
  {
    title: "Why two Nemotron models",
    lead: "The same cases with the reasoning steps on Ultra in the cloud or on Lightning on the laptop.",
    blocks: [{ doc: "docs/NEMOTRON.md", marker: "model-choice" }],
    images: [
      {
        src: "media/charts/model-choice.png",
        alt: "Chart: reasoning steps on Ultra in the cloud or Lightning locally.",
      },
    ],
  },
  {
    title: "Safety guard against injected text",
    lead: "The local guard model and the fixed patterns on texts written to attack the reviewer, in three labelled runs: the guard-only run (asked once), the 105-text full-review run (guard asked once) and the fresh-set run (current guard: asked twice, plus a narrow check). Every text is screened; the guard is not perfect, and misses are listed.",
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
    images: [{ src: "media/charts/model-latency.png", alt: "Chart: time per model call, by step and model." }],
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
    } else if (/^> /.test(line)) {
      out.push(`<p class="quote">${inline(doc, line.slice(2))}</p>`);
      i += 1;
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

/** The id of a section's heading, from its title. */
export const sectionId = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** The five lines at the top of the page, from the same generated facts as the home page. */
export function headlineLines(root = resolveProjectPath(".")): string[] {
  const f = siteFacts(root);
  return [
    `<strong>${esc(f.full_wrong)}</strong> risk cases wrongly closed by the full system on the 70-case exam, newest run.`,
    `<strong>${esc(f.alone_wrong)}</strong> wrongly closed by Nemotron alone with the free text, on the same cases.`,
    `<strong>ALR-0073</strong> (exam case EX-064): Nemotron alone closed it at ${esc(f.story_alone_conf)} confidence; the desk held it for a person in ${esc(f.story_desk_runs)} full-system runs.`,
    `<strong>${esc(f.receipts)}</strong> signed receipts, all verified against the pinned key: one for every Nightshift answer.`,
    `<strong>${esc(f.step_roles)}</strong> read-only Zetaris roles, one per review step that reads data.`,
  ];
}

export function renderResultsPage(root = resolveProjectPath(".")): string {
  const sections = RESULTS_SECTIONS.map((s) => {
    const blocks = s.blocks.map((b) => renderBlock(b.doc, blockOf(root, b.doc, b.marker))).join("\n");
    const img = (s.images ?? [])
      .map(
        (i) =>
          `<figure><a href="${esc(i.src)}"><img src="${esc(i.src)}" alt="${esc(i.alt)}" width="1920" height="1080" loading="lazy" /></a></figure>`,
      )
      .join("\n");
    const figures = (s.images ?? []).length > 1 ? `<div class="charts">${img}</div>` : img;
    const id = sectionId(s.title);
    return `<section class="section" aria-labelledby="${id}"><h2 id="${id}">${esc(s.title)}</h2><p class="lead">${esc(s.lead)}</p>\n${blocks}\n${figures}</section>`;
  });
  const toc = RESULTS_SECTIONS.map((s) => `<li><a href="#${sectionId(s.title)}">${esc(s.title)}</a></li>`).join("");
  const body = `      <p class="banner" role="note"><strong>Results as recorded.</strong> Every table on this page is copied from a block
      that a script writes into the <a href="${REPO_URL}">repository</a>'s README and docs from the committed result
      files; nothing here is typed in by hand. Every figure is one run unless it says otherwise.</p>
      <div class="page-head">
      <p class="crumbs"><a href="index.html">Sanctions Desk</a> / Results</p>
      <h1>Results</h1>
      <p class="muted measure">Customers and payments are synthetic; listed parties are public sanctions-list entries. Recorded
      runs step by step: <a href="runs/index.html">recorded runs</a>; every model call and its receipt:
      <a href="receipts/index.html">receipt log</a>.</p>
      </div>
      <section class="card headline" aria-labelledby="in-five-lines"><h2 id="in-five-lines">In five lines</h2><ul class="headline-lines">${headlineLines(
        root,
      )
        .map((l) => `<li>${l}</li>`)
        .join("")}</ul></section>
      <nav class="toc" aria-label="On this page"><ul>${toc}</ul></nav>
${sections.join("\n")}`;
  return pageOf(
    {
      title: "Sanctions Desk results",
      description:
        "Sanctions Desk results as recorded: the held-out rounds, the Nemotron scorecard, the studies of Nemotron alone and of model choice, the safety guard and the receipt statistics.",
      depth: 0,
      current: "results.html",
      bodyClass: "page-results",
    },
    body,
  );
}

/** Write site/results.html (or `<outDir>/results.html`). Returns the file written, relative to `outDir`. */
export function buildResultsPage(outDir: string, root = resolveProjectPath(".")): string {
  writeFileSync(join(outDir, "results.html"), renderResultsPage(root));
  return "results.html";
}

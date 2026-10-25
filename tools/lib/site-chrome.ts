/**
 * The parts every page of the static site shares: the document head (fonts, the one stylesheet site/site.css), the
 * top navigation bar, the footer and the HTML escape. The hand-written pages in site/ carry the same markup by hand;
 * the generated pages (results, recorded runs, receipt log) call these so the chrome cannot drift between them.
 */

export const REPO_URL = "https://github.com/rahulmahadik/sanctions-desk";

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The site's sections, in the order the top bar shows them; paths are relative to the site root. */
export const NAV_LINKS: ReadonlyArray<{ label: string; path: string }> = [
  { label: "Home", path: "index.html" },
  { label: "Results", path: "results.html" },
  { label: "Architecture", path: "architecture.html" },
  { label: "Replays", path: "runs/index.html" },
  { label: "Receipts", path: "receipts/index.html" },
  { label: "API", path: "api.html" },
];

/** The Google Fonts stylesheet the pages load (Inter for text, JetBrains Mono for ids and code); system fonts stand in. */
export const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

export interface PageOptions {
  title: string;
  description: string;
  /** How deep the page sits under the site root: 0 for site/x.html, 1 for site/runs/x.html. */
  depth: 0 | 1;
  /** The nav entry to mark as the current section (its path as in NAV_LINKS). */
  current?: string;
  /** A class on <body> for page-specific rules in site.css. */
  bodyClass?: string;
}

/** "../" repeated for the page's depth. */
export const prefixFor = (depth: 0 | 1) => (depth === 0 ? "" : "../");

export function headOf(o: PageOptions): string {
  const p = prefixFor(o.depth);
  return `  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#0b1a2e" />
    <meta name="description" content="${esc(o.description)}" />
    <title>${esc(o.title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${FONTS_URL}" />
    <link rel="stylesheet" href="${p}site.css" />
  </head>`;
}

export function topbarOf(o: Pick<PageOptions, "depth" | "current">): string {
  const p = prefixFor(o.depth);
  const items = NAV_LINKS.map(
    (l) => `<li><a href="${p}${l.path}"${l.path === o.current ? ' aria-current="page"' : ""}>${esc(l.label)}</a></li>`,
  );
  items.push(`<li><a class="external" href="${REPO_URL}" rel="noopener">GitHub</a></li>`);
  return `    <a class="skip-link" href="#main">Skip to content</a>
    <header class="topbar">
      <div class="container">
        <a class="brand" href="${p}index.html"><span class="brand-mark" aria-hidden="true">SD</span>Sanctions Desk</a>
        <nav aria-label="Site">
          <ul>
            ${items.join("\n            ")}
          </ul>
        </nav>
      </div>
    </header>`;
}

export function footerOf(): string {
  return `    <footer class="site-footer">
      <div class="container">
        <p>Sanctions Desk. The desk recommends; a person decides.</p>
        <p>Source and licence: <a href="${REPO_URL}">github.com/rahulmahadik/sanctions-desk</a> (Apache-2.0).</p>
      </div>
    </footer>`;
}

/** A whole page: head, top bar, the body inside <main class="container">, footer. */
export function pageOf(o: PageOptions, body: string): string {
  return `<!doctype html>
<html lang="en">
${headOf(o)}
  <body${o.bodyClass ? ` class="${esc(o.bodyClass)}"` : ""}>
${topbarOf(o)}
    <main id="main" class="container">
${body}
    </main>
${footerOf()}
  </body>
</html>
`;
}

/**
 * A table inside a card. `num` lists the columns (0-based) that hold numbers; they are right-aligned with tabular
 * figures. `id` lists columns of identifiers, kept on one line. Cells are HTML the caller has already escaped.
 */
export function tableOf(
  caption: string,
  head: string[],
  rows: string[][],
  cols: { num?: number[]; id?: number[] } = {},
): string {
  const cls = (j: number, tag: "th" | "td") => {
    const c = [cols.num?.includes(j) ? "num" : "", tag === "td" && cols.id?.includes(j) ? "id" : ""].filter(Boolean);
    return c.length ? ` class="${c.join(" ")}"` : "";
  };
  return `      <div class="wrap" role="region" aria-label="${esc(caption)}" tabindex="0">
        <table>
          <caption>${esc(caption)}</caption>
          <thead><tr>${head.map((h, j) => `<th scope="col"${cls(j, "th")}>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>
${rows.map((r) => `            <tr>${r.map((c, j) => `<td${cls(j, "td")}>${c}</td>`).join("")}</tr>`).join("\n")}
          </tbody>
        </table>
      </div>`;
}

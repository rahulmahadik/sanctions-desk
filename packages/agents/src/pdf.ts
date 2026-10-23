/**
 * A small PDF writer for the case file: A4 pages, Helvetica, headings, paragraphs, bullet lists and tables turned into
 * rows. No dependency. Only Latin-1 text can be drawn with the built-in font, so other letters (for example a listed
 * name in Cyrillic) are shown as "?" in the PDF; the Markdown case file keeps them.
 */

const PAGE = { width: 595, height: 842, margin: 54 };
const SIZES = { h1: 17, h2: 13, body: 9.5 } as const;
const LEADING = 1.38;

type Kind = "h1" | "h2" | "body";
interface Line {
  text: string;
  kind: Kind;
  bold: boolean;
  indent: number;
  gapBefore: number;
}

/** Approximate Helvetica widths in 1/1000 em; enough to wrap lines well. */
const NARROW = new Set("iljtfI.,:;'|!()[]/ ");
const WIDE = new Set("mwMW@%");
const widthOf = (text: string, size: number): number => {
  let w = 0;
  for (const ch of text) w += NARROW.has(ch) ? 0.28 : WIDE.has(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.5;
  return w * size;
};

/** Cut a word that is wider than the line into pieces that fit (a hash, for example). */
function cutWord(word: string, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let rest = word;
  while (widthOf(rest, size) > maxWidth) {
    let cut = rest.length;
    while (cut > 1 && widthOf(rest.slice(0, cut), size) > maxWidth) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/** Add a piece to the line being built; returns the line to carry on with and the line that was completed, if any. */
function place(current: string, piece: string, size: number, maxWidth: number): { current: string; done?: string } {
  const next = current ? `${current} ${piece}` : piece;
  if (widthOf(next, size) <= maxWidth) return { current: next };
  return current ? { current: piece, done: current } : { current: piece };
}

function wrap(text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const pieces = widthOf(word, size) > maxWidth ? cutWord(word, size, maxWidth) : [word];
    for (const piece of pieces) {
      const placed = place(current, piece, size, maxWidth);
      if (placed.done !== undefined) out.push(placed.done);
      current = placed.current;
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [""];
}

/** Typographic characters mapped to their plain forms; anything else outside Latin-1 becomes "?". */
const PLAIN: Readonly<Record<string, string>> = {
  "—": "-",
  "–": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "·": "-",
  "•": "-",
};
const COMBINING = /[\u0300-\u036f]/g;
const drawable = (code: number): boolean => (code >= 32 && code < 127) || (code >= 160 && code <= 255);

const latin1 = (text: string): string =>
  [...text.normalize("NFKD").replace(COMBINING, "")]
    .map((ch) => PLAIN[ch] ?? (drawable(ch.codePointAt(0) ?? 0) ? ch : "?"))
    .join("");

const escapePdf = (text: string): string =>
  latin1(text).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

const stripMarks = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^> ?/, "");

interface Styled {
  text: string;
  kind: Kind;
  indent?: number;
  gapBefore: number;
  bold?: boolean;
}

/** How one Markdown line is drawn: heading, table row, list item or paragraph. Undefined for lines that are not drawn. */
function style(row: string): Styled | undefined {
  if (row === "" || /^\|[\s:|-]+\|$/.test(row)) return undefined; // blank, or the separator line of a table
  if (row.startsWith("# ")) return { text: stripMarks(row.slice(2)), kind: "h1", gapBefore: 10 };
  if (row.startsWith("## ")) return { text: stripMarks(row.slice(3)), kind: "h2", gapBefore: 12 };
  if (row.startsWith("|")) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => stripMarks(c.trim()));
    return { text: cells.join("  |  "), kind: "body", indent: 8, gapBefore: 2 };
  }
  if (/^\s*[-*] /.test(row)) {
    return { text: `- ${stripMarks(row.replace(/^\s*[-*] /, ""))}`, kind: "body", indent: 10, gapBefore: 2 };
  }
  if (/^\d+\. /.test(row)) return { text: stripMarks(row), kind: "body", indent: 10, gapBefore: 2 };
  return { text: stripMarks(row), kind: "body", gapBefore: 5 };
}

/** Turn the Markdown the case file uses into styled lines. */
function layout(markdown: string): Line[] {
  const lines: Line[] = [];
  const textWidth = PAGE.width - 2 * PAGE.margin;
  for (const raw of markdown.split("\n")) {
    const styled = style(raw.trimEnd());
    if (!styled) continue;
    const indent = styled.indent ?? 0;
    const gap = lines.length === 0 && styled.kind === "h1" ? 0 : styled.gapBefore;
    wrap(styled.text, SIZES[styled.kind], textWidth - indent).forEach((t, i) => {
      lines.push({
        text: t,
        kind: styled.kind,
        bold: styled.bold ?? styled.kind !== "body",
        indent,
        gapBefore: i === 0 ? gap : 0,
      });
    });
  }
  return lines;
}

/** Fill pages with the lines, starting a new page when one is full. Each page is a list of drawing operations. */
function paginate(lines: readonly Line[]): string[][] {
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = PAGE.height - PAGE.margin;
  const newPage = () => {
    if (ops.length > 0) pages.push(ops);
    ops = [];
    y = PAGE.height - PAGE.margin;
  };
  for (const line of lines) {
    const size = SIZES[line.kind];
    if (y - (line.gapBefore + size * LEADING) < PAGE.margin + 18) newPage();
    y -= line.gapBefore + size * LEADING;
    ops.push(
      `BT /${line.bold ? "F2" : "F1"} ${size} Tf ${PAGE.margin + line.indent} ${y.toFixed(1)} Td (${escapePdf(line.text)}) Tj ET`,
    );
  }
  newPage();
  return pages.length > 0 ? pages : [[]];
}

export function markdownToPdf(markdown: string, footer = ""): Buffer {
  const pages = paginate(layout(markdown));
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  add(""); // 2: filled in below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 3
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"); // 4
  const pageIds: number[] = [];
  pages.forEach((content, i) => {
    const footerOps = `BT /F1 8 Tf ${PAGE.margin} 30 Td (${escapePdf(`${footer}${footer ? "   " : ""}page ${i + 1} of ${pages.length}`)}) Tj ET`;
    const stream = [...content, footerOps].join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    pageIds.push(add(page));
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  return serialise(objects);
}

/** Write the objects with the cross-reference table that tells a reader where each one starts. */
function serialise(objects: readonly string[]): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

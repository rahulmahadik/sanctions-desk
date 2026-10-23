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

function wrap(text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let piece = word;
    // a word longer than the line (a hash) is cut
    while (widthOf(piece, size) > maxWidth) {
      let cut = piece.length;
      while (cut > 1 && widthOf(piece.slice(0, cut), size) > maxWidth) cut -= 1;
      if (current) {
        out.push(current);
        current = "";
      }
      out.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    const next = current ? `${current} ${piece}` : piece;
    if (widthOf(next, size) <= maxWidth) current = next;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [""];
}

const latin1 = (text: string): string =>
  [...text.normalize("NFKD").replace(/[̀-ͯ]/g, "")]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 63;
      if (ch === "—" || ch === "–") return "-";
      if (ch === "‘" || ch === "’") return "'";
      if (ch === "“" || ch === "”") return '"';
      if (ch === "…") return "...";
      if (ch === "·" || ch === "•") return "-";
      return code >= 32 && code < 127 ? ch : code >= 160 && code <= 255 ? ch : "?";
    })
    .join("");

const escapePdf = (text: string): string =>
  latin1(text).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

const stripMarks = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^> ?/, "");

/** Turn the Markdown the case file uses into styled lines. */
function layout(markdown: string): Line[] {
  const lines: Line[] = [];
  const textWidth = PAGE.width - 2 * PAGE.margin;
  const push = (text: string, kind: Kind, o: { bold?: boolean; indent?: number; gapBefore?: number } = {}) => {
    const size = SIZES[kind];
    const indent = o.indent ?? 0;
    wrap(text, size, textWidth - indent).forEach((t, i) =>
      lines.push({
        text: t,
        kind,
        bold: o.bold ?? kind !== "body",
        indent,
        gapBefore: i === 0 ? (o.gapBefore ?? 0) : 0,
      }),
    );
  };
  for (const raw of markdown.split("\n")) {
    const row = raw.trimEnd();
    if (row === "") continue;
    if (/^\|[\s:|-]+\|$/.test(row)) continue; // the separator line of a table
    if (row.startsWith("# ")) push(stripMarks(row.slice(2)), "h1", { gapBefore: lines.length ? 10 : 0 });
    else if (row.startsWith("## ")) push(stripMarks(row.slice(3)), "h2", { gapBefore: 12 });
    else if (row.startsWith("|")) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => stripMarks(c.trim()));
      push(cells.join("  |  "), "body", { indent: 8, gapBefore: 2 });
    } else if (/^\s*[-*] /.test(row))
      push(`- ${stripMarks(row.replace(/^\s*[-*] /, ""))}`, "body", { indent: 10, gapBefore: 2 });
    else if (/^\d+\. /.test(row)) push(stripMarks(row), "body", { indent: 10, gapBefore: 2 });
    else push(stripMarks(row), "body", { gapBefore: 5 });
  }
  return lines;
}

export function markdownToPdf(markdown: string, footer = ""): Buffer {
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = PAGE.height - PAGE.margin;
  const newPage = () => {
    if (ops.length > 0) pages.push(ops);
    ops = [];
    y = PAGE.height - PAGE.margin;
  };
  for (const line of layout(markdown)) {
    const size = SIZES[line.kind];
    const need = line.gapBefore + size * LEADING;
    if (y - need < PAGE.margin + 18) newPage();
    y -= line.gapBefore + size * LEADING;
    ops.push(
      `BT /${line.bold ? "F2" : "F1"} ${size} Tf ${PAGE.margin + line.indent} ${y.toFixed(1)} Td (${escapePdf(line.text)}) Tj ET`,
    );
  }
  newPage();
  if (pages.length === 0) pages.push([]);

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
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

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

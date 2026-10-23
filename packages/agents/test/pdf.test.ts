import { describe, expect, it } from "vitest";
import { markdownToPdf } from "../src/index.js";

const text = (pdf: Buffer) => pdf.toString("latin1");

describe("the PDF writer", () => {
  it("writes a well-formed file: header, objects at the offsets the table names, trailer", () => {
    const pdf = text(markdownToPdf("# Title\n\nA paragraph.\n\n## Section\n\n- one\n- two\n"));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(pdf);
    expect(table).not.toBeNull();
    const rows = (table?.[2] ?? "").trimEnd().split("\n").slice(1);
    rows.forEach((row, i) => {
      const offset = Number(row.slice(0, 10));
      expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    const start = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
  });

  it("escapes brackets and backslashes, and shows letters the font cannot draw as question marks", () => {
    const pdf = text(markdownToPdf("# A (b) \\ c\n\nИван Петров, Zoë, naïve\n"));
    expect(pdf).toContain("\\(b\\)");
    expect(pdf).toContain("\\\\");
    expect(pdf).toContain("???? ??????");
    expect(pdf).toContain("Zoe");
  });

  it("starts a new page when one is full, and numbers the pages with the footer", () => {
    const pdf = text(markdownToPdf("Line\n".repeat(200), "record abc123"));
    const pages = (pdf.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect(pdf).toContain(`record abc123   page 1 of ${pages}`);
    expect(pdf).toContain(`page ${pages} of ${pages}`);
  });

  it("breaks a very long word (a hash) instead of running off the page", () => {
    const pdf = text(markdownToPdf(`${"a".repeat(300)}\n`));
    const lines = (pdf.match(/\(a+\) Tj/g) ?? []).length;
    expect(lines).toBeGreaterThan(1);
  });

  it("writes an empty document as one page", () => {
    expect((text(markdownToPdf("")).match(/\/Type \/Page /g) ?? []).length).toBe(1);
  });
});

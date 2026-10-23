import { existsSync, readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadExam } from "../src/exam.js";

const RegistrySchema = z.object({
  note: z.string(),
  edge_cases: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9_]+$/),
      area: z.string(),
      what: z.string().min(10),
      expected: z.string().min(5),
      covered_by: z.array(z.string().regex(/^(exam|test):/)).min(1),
    }),
  ),
});
const registry = RegistrySchema.parse(JSON.parse(readFileSync(resolveProjectPath("eval/edge-cases.json"), "utf8")));
const exam = loadExam();

describe("the edge-case registry", () => {
  it("has unique ids", () => {
    const ids = registry.edge_cases.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every exam entry at a case that exists", () => {
    for (const edge of registry.edge_cases) {
      for (const ref of edge.covered_by.filter((r) => r.startsWith("exam:"))) {
        const kind = ref.slice("exam:".length);
        const matches = kind.endsWith("*")
          ? exam.cases.filter((c) => c.kind.startsWith(kind.slice(0, -1)))
          : exam.cases.filter((c) => c.kind === kind);
        expect(matches.length, `${edge.id} → ${ref}`).toBeGreaterThan(0);
      }
    }
  });

  it("points every test entry at a file that exists and a phrase that appears in it", () => {
    for (const edge of registry.edge_cases) {
      for (const ref of edge.covered_by.filter((r) => r.startsWith("test:"))) {
        const [path, phrase] = ref.slice("test:".length).split("::");
        const file = resolveProjectPath(path ?? "");
        expect(existsSync(file), `${edge.id} → ${path}`).toBe(true);
        if (phrase)
          expect(readFileSync(file, "utf8").toLowerCase(), `${edge.id} → ${ref}`).toContain(phrase.toLowerCase());
      }
    }
  });

  it("knows every edge-case tag that the exam uses", () => {
    const known = new Set(registry.edge_cases.map((e) => e.id));
    const used = new Set(exam.cases.flatMap((c) => c.edge_cases));
    expect([...used].filter((tag) => !known.has(tag))).toEqual([]);
  });

  it("covers the areas of the review's edge-case list", () => {
    const areas = new Set(registry.edge_cases.map((e) => e.area));
    expect(areas).toEqual(
      new Set(["names", "ownership", "lists and memory", "data and systems", "security", "payments"]),
    );
  });
});

describe("the edge-case page", () => {
  it("lists every edge case in the registry", () => {
    const page = readFileSync(resolveProjectPath("docs/EDGE_CASES.md"), "utf8");
    for (const edge of registry.edge_cases) expect(page, edge.id).toContain(edge.what);
  });
});

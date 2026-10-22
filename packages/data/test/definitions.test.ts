import { describe, expect, it } from "vitest";
import { checkDefinitions, IMPLEMENTED_DEFINITIONS, loadBusinessDefinitions } from "../src/index.js";

describe("committed business definitions", () => {
  const rows = loadBusinessDefinitions();
  it("define every term the code implements, at the version it implements", () => {
    const check = checkDefinitions(rows);
    expect(check.mismatched).toEqual([]);
    expect(check.applied.map((d) => d.definition_id)).toEqual(Object.keys(IMPLEMENTED_DEFINITIONS).sort());
  });
  it("have unique keys that match their id and version", () => {
    expect(new Set(rows.map((r) => r.definition_key)).size).toBe(rows.length);
    for (const r of rows) expect(r.definition_key).toBe(`${r.definition_id}@${r.version}`);
  });
});

describe("checkDefinitions", () => {
  it("uses the newest approved version and ignores drafts and retired ones", () => {
    const check = checkDefinitions([
      { definition_id: "true_match", version: "1", status: "approved" },
      { definition_id: "true_match", version: "2", status: "draft" },
      { definition_id: "strong_identifier", version: "1", status: "retired" },
    ]);
    expect(check.applied).toEqual([{ definition_id: "true_match", version: "1" }]);
  });
  it("reports a newer approved version and a missing definition", () => {
    const check = checkDefinitions([{ definition_id: "true_match", version: "2", status: "approved" }]);
    expect(check.mismatched).toContainEqual({ definition_id: "true_match", approved: "2", implemented: "1" });
    expect(check.mismatched).toContainEqual({ definition_id: "strong_identifier", approved: "none", implemented: "1" });
  });
});

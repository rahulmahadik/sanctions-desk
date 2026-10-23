import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyProposedMask, applyRowFilter, parseProposal, planFor, stepsOutsideSql } from "../src/access-proposal.js";
import { USL_TABLES } from "../src/index.js";

const file = new URL("../../../zetaris/proposals/screening_usl.access.ddl", import.meta.url);
const model = "lightning.metastore.sanctions.screening_usl";
const tables = USL_TABLES.map((t) => t.name);

describe("the proposed access syntax", () => {
  const statements = parseProposal(readFileSync(file, "utf8"));

  it("reads every statement of the committed proposal", () => {
    expect(statements.map((s) => s.kind)).toEqual([
      "create_role",
      "create_role",
      "create_role",
      "create_user",
      "create_user",
      "grant_all",
      "grant_all",
      "grant_table",
      "mask",
      "row_filter",
    ]);
  });

  it("rejects a statement that is not part of the proposal", () => {
    expect(() => parseProposal("DROP ROLE x;")).toThrow(/not a statement of the proposal/);
  });

  it("turns grants into one SQL statement per table and says what only the interface can do", () => {
    const plan = planFor(statements, model, tables);
    const grant = plan.find((p) => p.statement.kind === "grant_all");
    expect(grant?.today).toHaveLength(tables.length);
    expect(grant?.today[0]).toMatch(/^GRANT SELECT ON USL TABLE lightning\.metastore\.sanctions\.screening_usl\./);
    expect(plan.filter((p) => p.channel === "interface").map((p) => p.statement.kind)).toEqual(["mask", "row_filter"]);
    expect(plan.find((p) => p.statement.kind === "create_user")?.channel).toBe("rest");
    expect(stepsOutsideSql(plan)).toBe(4);
  });

  it("masks all but the last two characters", () => {
    expect(applyProposedMask("AB12345678", ".(?=.{2})", "*")).toBe("********78");
    expect(applyProposedMask("12", ".(?=.{2})", "*")).toBe("12");
  });

  it("keeps only the rows a row filter allows", () => {
    const rows = [
      { id: "1", desk: "EMEA" },
      { id: "2", desk: "APAC" },
    ];
    expect(applyRowFilter(rows, "desk = 'EMEA'")).toEqual([{ id: "1", desk: "EMEA" }]);
    expect(() => applyRowFilter(rows, "desk LIKE 'E%'")).toThrow(/equality/);
  });
});

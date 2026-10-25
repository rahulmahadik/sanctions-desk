import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBank, TABLES, type TableRows } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { assessNote } from "../src/index.js";

/**
 * Records which of the eight "clear" held-out cases carry text that meets the documentary standard (the labels were
 * not changed for it), so the report can say how many closes are reachable under it.
 */
function sampleTables(): TableRows {
  const dir = resolveProjectPath("data/sample");
  const tables: Record<string, unknown[]> = {};
  for (const [name, schema] of Object.entries(TABLES)) {
    tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  }
  return tables as unknown as TableRows;
}

const hashOf = (cases: unknown[]) =>
  createHash("sha256")
    .update(JSON.stringify(sortKeys(cases)))
    .digest("hex");
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;

describe("the held-out set across its three freezes", () => {
  const bank = buildBank(sampleTables(), ["a"]);
  const frozen = JSON.parse(readFileSync(resolveProjectPath("eval/cases/heldout.json"), "utf8")) as {
    cases: Array<{ case_id: string; expected: string; acceptable: string[]; must_not: string[] }>;
  };

  it("matches the committed file", () => {
    expect(JSON.stringify(bank.heldout)).toBe(JSON.stringify(frozen.cases));
    expect(frozen.cases).toHaveLength(30);
  });

  it("keeps HO-001 to HO-018 (freeze 1) and HO-001 to HO-022 (freeze 2) byte-identical", () => {
    expect(hashOf(frozen.cases.slice(0, 18))).toBe("d2486f5c0a974a5259dd8b43c27d4ebfe8cdb4b1a686a8abd935529e91eb27bf");
    expect(hashOf(frozen.cases.slice(0, 22))).toBe("f5e05ca14ffed00929b9137c2607a3759c9733666dceff44c45084e5e13a50be");
  });

  it("relabels HO-023 to HO-026 to NEED_MORE_INFO, with escalation acceptable and a close a miss", () => {
    for (const c of frozen.cases.slice(22, 26)) {
      expect(c).toMatchObject({
        expected: "NEED_MORE_INFO",
        acceptable: ["ESCALATE_L2"],
        must_not: ["CLOSE_FALSE_POSITIVE"],
      });
    }
  });

  const text = (caseId: string) => {
    const c = bank.heldout.find((x) => x.case_id === caseId);
    if (!c) throw new Error(`no case ${caseId}`);
    const t = bank.tablesWithHeldout;
    if (c.alert_type === "payment") {
      const payment = t.payment.find(
        (p) => p.payment_id === t.alert.find((a) => a.alert_id === c.alert_id)?.payment_id,
      );
      return { text: payment?.payment_reference, payment: { counterpartyName: payment?.counterparty_name } };
    }
    return { text: t.customer.find((r) => r.customer_id === c.customer_id)?.notes };
  };

  it("has eight clear cases, and the text of every one meets the documentary standard (8 of 8 reachable)", () => {
    const clear = frozen.cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE").map((c) => c.case_id);
    expect(clear).toEqual(["HO-019", "HO-020", "HO-021", "HO-022", "HO-027", "HO-028", "HO-029", "HO-030"]);
    expect(clear.map((id) => assessNote(text(id)).documentary)).toEqual(clear.map(() => true));
  });

  it("keeps the four relabelled cases as claims under the standard", () => {
    expect(["HO-023", "HO-024", "HO-025", "HO-026"].map((id) => assessNote(text(id)).documentary)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

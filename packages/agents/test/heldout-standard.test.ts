import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBank, TABLES, type TableRows } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { assessNote } from "../src/index.js";

/**
 * The documentary standard was added before the held-out run, and the held-out labels were not changed. This records
 * which of the eight "clear" cases carry text that meets the standard, so the report can say how many closes are
 * reachable under it.
 */
function sampleTables(): TableRows {
  const dir = resolveProjectPath("data/sample");
  const tables: Record<string, unknown[]> = {};
  for (const [name, schema] of Object.entries(TABLES)) {
    tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  }
  return tables as unknown as TableRows;
}

describe("the held-out clear cases under the documentary standard", () => {
  const bank = buildBank(sampleTables(), ["a"]);
  const clear = bank.heldout.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE");

  it("keeps every held-out label as frozen", () => {
    const frozen = JSON.parse(readFileSync(resolveProjectPath("eval/cases/heldout.json"), "utf8")) as {
      cases: unknown[];
    };
    expect(JSON.stringify(bank.heldout)).toBe(JSON.stringify(frozen.cases));
    expect(clear).toHaveLength(8);
  });

  const meets = (caseId: string): boolean => {
    const c = clear.find((x) => x.case_id === caseId);
    if (!c) throw new Error(`no case ${caseId}`);
    const customer = bank.tablesWithHeldout.customer.find((r) => r.customer_id === c.customer_id);
    if (c.alert_type === "payment") {
      const payment = bank.tablesWithHeldout.payment.find(
        (p) => p.payment_id === bank.tablesWithHeldout.alert.find((a) => a.alert_id === c.alert_id)?.payment_id,
      );
      return assessNote({
        text: payment?.payment_reference,
        payment: { counterpartyName: payment?.counterparty_name },
      }).documentary;
    }
    return assessNote({ text: customer?.notes }).documentary;
  };

  it("lets the four notes that carry a check reference, a document number and a date support a close", () => {
    expect(["HO-019", "HO-020", "HO-021", "HO-022"].map(meets)).toEqual([true, true, true, true]);
  });

  it("treats the other four as claims, so a close on them goes to NEED_MORE_INFO", () => {
    expect(["HO-023", "HO-024", "HO-025", "HO-026"].map(meets)).toEqual([false, false, false, false]);
  });
});

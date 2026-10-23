import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBank, TABLES, type TableRows } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { assessNote } from "../src/index.js";

/**
 * The second held-out set was written before any system output on it was seen. This pins its file hash, so a change
 * after the hash was recorded in eval/cases/README.md fails here, and checks the labels against the documentary
 * evidence standard as written: every clear meets it, every claim fails it.
 */
const FROZEN_SHA256 = "88439234fddb459babdd039551acddc09463fabd733573a7e9cba3bf63a29dbe";
const FILE = "eval/cases/heldout2.json";

function sampleTables(): TableRows {
  const dir = resolveProjectPath("data/sample");
  const tables: Record<string, unknown[]> = {};
  for (const [name, schema] of Object.entries(TABLES)) {
    tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  }
  return tables as unknown as TableRows;
}

describe("the second held-out set", () => {
  const snapshots = (
    JSON.parse(readFileSync(resolveProjectPath("data/sample/manifest.json"), "utf8")) as {
      snapshots: Array<{ snapshot_id: string }>;
    }
  ).snapshots.map((s) => s.snapshot_id);
  const bank = buildBank(sampleTables(), snapshots);
  const raw = readFileSync(resolveProjectPath(FILE), "utf8");
  const frozen = JSON.parse(raw) as {
    cases: Array<{ case_id: string; kind: string; expected: string; acceptable: string[]; must_not: string[] }>;
  };

  it("has the recorded hash", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FROZEN_SHA256);
  });

  it("matches what the builder produces", () => {
    expect(JSON.stringify(bank.heldout2)).toBe(JSON.stringify(frozen.cases));
    expect(frozen.cases.map((c) => c.case_id)).toEqual(
      Array.from({ length: frozen.cases.length }, (_, i) => `HO2-${String(i + 1).padStart(3, "0")}`),
    );
  });

  const text = (caseId: string) => {
    const c = bank.heldout2.find((x) => x.case_id === caseId);
    if (!c) throw new Error(`no case ${caseId}`);
    const t = bank.tablesWithHeldout2;
    if (c.alert_type === "payment") {
      const payment = t.payment.find(
        (p) => p.payment_id === t.alert.find((a) => a.alert_id === c.alert_id)?.payment_id,
      );
      return { text: payment?.payment_reference, payment: { counterpartyName: payment?.counterparty_name } };
    }
    return { text: t.customer.find((r) => r.customer_id === c.customer_id)?.notes };
  };

  const ids = (expected: string, prefix: string) =>
    frozen.cases.filter((c) => c.expected === expected && c.kind.startsWith(prefix)).map((c) => c.case_id);

  it("splits into 7 risks stated in free text, 5 documented clears and 3 claims", () => {
    expect(ids("ESCALATE_L2", "ho2_")).toHaveLength(7);
    expect(ids("CLOSE_FALSE_POSITIVE", "ho2_clear_")).toHaveLength(5);
    expect(ids("NEED_MORE_INFO", "ho2_claim_")).toHaveLength(3);
    expect(frozen.cases).toHaveLength(15);
  });

  it("lists a close as a miss on every risk and every claim, and an escalation as a miss on every clear", () => {
    for (const c of frozen.cases) {
      if (c.expected === "CLOSE_FALSE_POSITIVE") {
        expect(c.acceptable, c.case_id).toEqual([]);
        expect(c.must_not, c.case_id).toEqual(["RECOMMEND_BLOCK"]);
      } else {
        expect(c.must_not, c.case_id).toEqual(["CLOSE_FALSE_POSITIVE"]);
        expect(c.acceptable, c.case_id).not.toContain("CLOSE_FALSE_POSITIVE");
      }
    }
  });

  it("gives every clear text that meets the documentary standard", () => {
    const clear = ids("CLOSE_FALSE_POSITIVE", "ho2_clear_");
    expect(clear.map((id) => assessNote(text(id)))).toEqual(clear.map(() => ({ documentary: true, missing: [] })));
  });

  it("gives every claim text that fails the standard, for the one reason it was written to fail", () => {
    expect(ids("NEED_MORE_INFO", "ho2_claim_").map((id) => assessNote(text(id)).missing)).toEqual([
      ["a check reference"],
      ["a named counterparty"],
      ["a date"],
    ]);
  });

  it("gives no risk case text that meets the standard, so none of them could be cleared by it", () => {
    for (const id of ids("ESCALATE_L2", "ho2_")) expect(assessNote(text(id)).documentary, id).toBe(false);
  });
});

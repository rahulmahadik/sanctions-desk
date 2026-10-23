import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBank, TABLES, type TableRows } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { assessNote, documentaryDateOfBirth } from "../src/index.js";

/**
 * The second held-out set was written before any system output on it was seen. This pins its file hash, so a change
 * after the hash was recorded in eval/cases/README.md fails here, and checks the labels against the documentary
 * evidence standard as written: every clear meets it, every claim fails it.
 */
const FROZEN_SHA256 = "5b338bd72e54f1f2a00b3b6b25b9dd76f0afdf7eca25c3fea40748d02466f9a8";
const FILE = "eval/cases/heldout2.json";
/** The case file names the rows; this pins the rows themselves (the text the labels were written against). */
const ROWS_SHA256 = "a2a0eba3d0edc67adf832b181cc5fcefc235ec448d6e42545868ccad562138ad";

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

  it("builds the same rows (notes, references and fields) as when the hash was recorded", () => {
    const t = bank.tablesWithHeldout2 as unknown as Record<string, Array<Record<string, unknown>>>;
    const rows = Object.keys(t)
      .sort()
      .map((name) => [name, (t[name] ?? []).filter((r) => /^[A-Z]+-J\d/.test(String(Object.values(r)[0])))]);
    expect(createHash("sha256").update(JSON.stringify(rows)).digest("hex")).toBe(ROWS_SHA256);
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

  it("splits into 9 risks stated in free text, 5 documented clears, 3 claims and 2 clears refused for no usable country", () => {
    expect(ids("ESCALATE_L2", "ho2_")).toHaveLength(9);
    expect(ids("CLOSE_FALSE_POSITIVE", "ho2_clear_")).toEqual(["HO2-008", "HO2-011", "HO2-012", "HO2-018", "HO2-019"]);
    expect(ids("NEED_MORE_INFO", "ho2_claim_")).toHaveLength(3);
    expect(ids("NEED_MORE_INFO", "ho2_clear_")).toEqual(["HO2-009", "HO2-010"]);
    expect(frozen.cases).toHaveLength(19);
  });

  it("refuses a close on HO2-009 and HO2-010: the text is documentary but the counterparty has no usable country", () => {
    for (const id of ["HO2-009", "HO2-010"]) {
      expect(frozen.cases.find((c) => c.case_id === id)).toMatchObject({
        expected: "NEED_MORE_INFO",
        acceptable: ["ESCALATE_L2"],
        must_not: ["CLOSE_FALSE_POSITIVE"],
      });
      expect(assessNote(text(id)).documentary, id).toBe(true);
      const t = bank.tablesWithHeldout2;
      const alert = t.alert.find((a) => a.alert_id === frozen.cases.find((c) => c.case_id === id)?.alert_id);
      expect(t.payment.find((p) => p.payment_id === alert?.payment_id)?.counterparty_country, id).toBe("XX");
    }
  });

  const listed = (entryId: string | null) => {
    const sample = sampleTables();
    return {
      dobs: sample.list_dob.filter((d) => d.entry_id === entryId),
      nationalities: sample.list_country
        .filter((x) => x.entry_id === entryId && (x.role === "nationality" || x.role === "citizenship"))
        .map((x) => x.country_iso2),
      ids: sample.list_identifier.filter((x) => x.entry_id === entryId).map((x) => x.id_number),
    };
  };
  const conflictsWithEvery = (dob: string, dobs: ReturnType<typeof listed>["dobs"]) =>
    dobs.length > 0 &&
    dobs.every((d) =>
      d.dob_precision === "range"
        ? dob < (d.range_from ?? "") || dob > (d.range_to ?? "")
        : d.dob_precision === "year"
          ? dob.slice(0, 4) !== d.dob_value
          : dob !== d.dob_value,
    );

  it("gives HO2-016 and HO2-017 structured fields that alone meet the false-positive definition", () => {
    const t = bank.tablesWithHeldout2;
    for (const id of ["HO2-016", "HO2-017"]) {
      const c = bank.heldout2.find((x) => x.case_id === id);
      const customer = t.customer.find((r) => r.customer_id === c?.customer_id);
      const l = listed(c?.entry_id ?? null);
      expect(customer?.date_of_birth, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(conflictsWithEvery(customer?.date_of_birth ?? "", l.dobs), id).toBe(true);
      expect(l.nationalities, id).not.toContain(customer?.nationality);
      const own = t.customer_identifier.filter((r) => r.customer_id === c?.customer_id).map((r) => r.id_number);
      expect(
        own.filter((n) => l.ids.includes(n)),
        id,
      ).toEqual([]);
      expect(c?.expected).toBe("ESCALATE_L2");
    }
  });

  it("gives HO2-018 and HO2-019 an empty birth date and a documentary note whose labelled birth date conflicts", () => {
    const t = bank.tablesWithHeldout2;
    for (const id of ["HO2-018", "HO2-019"]) {
      const c = bank.heldout2.find((x) => x.case_id === id);
      const customer = t.customer.find((r) => r.customer_id === c?.customer_id);
      const l = listed(c?.entry_id ?? null);
      expect(customer?.date_of_birth, id).toBeNull();
      const stated = documentaryDateOfBirth(customer?.notes);
      expect(stated, id).not.toBeNull();
      expect(conflictsWithEvery(stated?.value ?? "", l.dobs), id).toBe(true);
      expect(l.nationalities, id).not.toContain(customer?.nationality);
      expect(
        t.customer_identifier.filter((r) => r.customer_id === c?.customer_id),
        id,
      ).toEqual([]);
    }
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

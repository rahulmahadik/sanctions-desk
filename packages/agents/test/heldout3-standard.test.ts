import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBank, isIso2, TABLES, type TableRows } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { assessNote, documentaryDateOfBirth } from "../src/index.js";

/**
 * The third held-out set was written from the written definitions before any system output on it was seen. This
 * pins its file hash and the hash of the rows it points at, so a change after the hashes were recorded in
 * eval/cases/README.md fails here, and checks the labels against the definitions and the documentary evidence
 * standard as written: every clear is reachable and meets the standard, every risk carries its relationship in text.
 */
const FROZEN_SHA256 = "62ef25460bdc91e8ee7971d5f267e2f727ff8d0c860a24622b2c5df634b954a9";
const FILE = "eval/cases/heldout3.json";
/** The case file names the rows; this pins the rows themselves (the text the labels were written against). */
const ROWS_SHA256 = "52e554497273286eb1da488729bb52d129a4a7f34c16cac20d9f0ca53425f594";

function sampleTables(): TableRows {
  const dir = resolveProjectPath("data/sample");
  const tables: Record<string, unknown[]> = {};
  for (const [name, schema] of Object.entries(TABLES)) {
    tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  }
  return tables as unknown as TableRows;
}

describe("the third held-out set", () => {
  const sample = sampleTables();
  const snapshots = (
    JSON.parse(readFileSync(resolveProjectPath("data/sample/manifest.json"), "utf8")) as {
      snapshots: Array<{ snapshot_id: string }>;
    }
  ).snapshots.map((s) => s.snapshot_id);
  const bank = buildBank(sample, snapshots);
  const t = bank.tablesWithHeldout3;
  const raw = readFileSync(resolveProjectPath(FILE), "utf8");
  const frozen = JSON.parse(raw) as {
    cases: Array<{
      case_id: string;
      kind: string;
      expected: string;
      acceptable: string[];
      must_not: string[];
      edge_cases: string[];
    }>;
  };

  it("has the recorded hash", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FROZEN_SHA256);
  });

  it("builds the same rows (notes, references and fields) as when the hash was recorded", () => {
    const all = t as unknown as Record<string, Array<Record<string, unknown>>>;
    const rows = Object.keys(all)
      .sort()
      .map((name) => [name, (all[name] ?? []).filter((r) => /^[A-Z]+-K\d/.test(String(Object.values(r)[0])))]);
    expect(createHash("sha256").update(JSON.stringify(rows)).digest("hex")).toBe(ROWS_SHA256);
  });

  it("matches what the builder produces", () => {
    expect(JSON.stringify(bank.heldout3)).toBe(JSON.stringify(frozen.cases));
    expect(frozen.cases.map((c) => c.case_id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `HO3-${String(i + 1).padStart(3, "0")}`),
    );
  });

  const caseOf = (id: string) => {
    const c = bank.heldout3.find((x) => x.case_id === id);
    if (!c) throw new Error(`no case ${id}`);
    return c;
  };
  const paymentOf = (id: string) =>
    t.payment.find((p) => p.payment_id === t.alert.find((a) => a.alert_id === caseOf(id).alert_id)?.payment_id);
  const customerOf = (id: string) => t.customer.find((r) => r.customer_id === caseOf(id).customer_id);
  const text = (id: string) => {
    if (caseOf(id).alert_type === "payment") {
      const payment = paymentOf(id);
      return { text: payment?.payment_reference, payment: { counterpartyName: payment?.counterparty_name } };
    }
    return { text: customerOf(id)?.notes };
  };
  const listed = (id: string) => {
    const entryId = caseOf(id).entry_id;
    return {
      name: sample.list_entry.find((e) => e.entry_id === entryId)?.primary_name ?? "",
      dobs: sample.list_dob.filter((d) => d.entry_id === entryId),
      nationalities: sample.list_country
        .filter((x) => x.entry_id === entryId && (x.role === "nationality" || x.role === "citizenship"))
        .map((x) => x.country_iso2),
      countries: sample.list_country.filter((x) => x.entry_id === entryId).map((x) => x.country_iso2),
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

  const RISKS = ["HO3-001", "HO3-002", "HO3-003", "HO3-004", "HO3-005", "HO3-006"];
  const CLEARS = ["HO3-007", "HO3-008", "HO3-009", "HO3-010", "HO3-011", "HO3-012"];

  it("splits into 6 risks and 6 clears, with a close a miss on every risk and a block a miss on every clear", () => {
    const by = (expected: string) => frozen.cases.filter((c) => c.expected === expected).map((c) => c.case_id);
    expect(by("ESCALATE_L2")).toEqual(RISKS);
    expect(by("CLOSE_FALSE_POSITIVE")).toEqual(CLEARS);
    for (const c of frozen.cases) {
      if (c.expected === "CLOSE_FALSE_POSITIVE") {
        expect(c.acceptable, c.case_id).toEqual([]);
        expect(c.must_not, c.case_id).toEqual(["RECOMMEND_BLOCK"]);
      } else {
        expect(c.must_not, c.case_id).toEqual(["CLOSE_FALSE_POSITIVE"]);
        // Asking for more is acceptable only where the link rests on a claim (a press report), not a stated fact.
        expect(c.acceptable, c.case_id).toEqual(c.case_id === "HO3-006" ? ["NEED_MORE_INFO"] : []);
      }
    }
  });

  it("states each risk's relationship to the listed party in the text, naming the listed party in full", () => {
    const relationship: Record<string, RegExp> = {
      "HO3-001": /\bson of\b/i,
      "HO3-002": /\bdiretor executivo da\b/i,
      "HO3-003": /\bas nominee for\b/i,
      "HO3-004": /\ba company owned by\b/i,
      "HO3-005": /\bsocio al 50% di\b/i,
      "HO3-006": /\btrustee\b.*\benige begunstigde\b/i,
    };
    for (const id of RISKS) {
      const note = text(id).text ?? "";
      expect(note, id).toMatch(relationship[id] as RegExp);
      const tokens = listed(id).name.toLowerCase().split(/\s+/);
      for (const token of tokens) expect(note.toLowerCase(), `${id}: ${token}`).toContain(token);
    }
    expect(caseOf("HO3-004").alert_type).toBe("payment");
    const languages = RISKS.filter((id) => caseOf(id).edge_cases.includes("non_english_text"));
    expect(languages).toEqual(["HO3-002", "HO3-005", "HO3-006"]);
  });

  it("gives no risk case text that meets the standard, so none of them could be cleared by it", () => {
    for (const id of RISKS) expect(assessNote(text(id)).documentary, id).toBe(false);
  });

  it("gives HO3-001, HO3-003 and HO3-005 structured fields that alone meet the false-positive definition", () => {
    for (const id of ["HO3-001", "HO3-003", "HO3-005"]) {
      const customer = customerOf(id);
      const l = listed(id);
      expect(caseOf(id).edge_cases, id).toContain("rules_would_close");
      expect(
        l.dobs.map((d) => d.dob_precision),
        id,
      ).toEqual(["day"]);
      expect(customer?.date_of_birth, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(conflictsWithEvery(customer?.date_of_birth ?? "", l.dobs), id).toBe(true);
      expect(l.nationalities, id).not.toContain(customer?.nationality);
      const own = t.customer_identifier.filter((r) => r.customer_id === customer?.customer_id).map((r) => r.id_number);
      expect(
        own.filter((n) => l.ids.includes(n)),
        id,
      ).toEqual([]);
    }
  });

  it("gives every clear text that meets the documentary standard", () => {
    expect(CLEARS.map((id) => assessNote(text(id)))).toEqual(CLEARS.map(() => ({ documentary: true, missing: [] })));
  });

  it("makes every customer clear reachable: no birth date on record, answered by a documentary labelled birth date that conflicts", () => {
    for (const id of ["HO3-007", "HO3-008", "HO3-009", "HO3-010"]) {
      const customer = customerOf(id);
      const l = listed(id);
      expect(customer?.date_of_birth, id).toBeNull();
      expect(isIso2(customer?.nationality ?? ""), id).toBe(true);
      const stated = documentaryDateOfBirth(customer?.notes);
      expect(stated, id).not.toBeNull();
      expect(conflictsWithEvery(stated?.value ?? "", l.dobs), id).toBe(true);
      expect(l.nationalities, id).not.toContain(customer?.nationality);
      expect(
        t.customer_identifier.filter((r) => r.customer_id === customer?.customer_id),
        id,
      ).toEqual([]);
    }
  });

  it("makes every payment clear reachable: a named counterparty with a usable country not linked to the listed party", () => {
    for (const id of ["HO3-011", "HO3-012"]) {
      const payment = paymentOf(id);
      expect(isIso2(payment?.counterparty_country ?? ""), id).toBe(true);
      expect(listed(id).countries, id).not.toContain(payment?.counterparty_country);
      expect(Number(payment?.amount), id).toBeGreaterThan(0);
    }
    const stated = documentaryDateOfBirth(text("HO3-012").text);
    expect(conflictsWithEvery(stated?.value ?? "", listed("HO3-012").dobs)).toBe(true);
  });

  it("puts the listed name, or words that only sound like a relationship, next to a name in the clears", () => {
    const wording: Record<string, RegExp> = {
      "HO3-007": /name check against the listed person/i,
      "HO3-008": /father's name/i,
      "HO3-009": /director of studies/i,
      "HO3-010": /nominee for the .* award/i,
      "HO3-011": /sister company of our .* branch office/i,
      "HO3-012": /name check against the listed person/i,
    };
    for (const id of CLEARS) expect(text(id).text, id).toMatch(wording[id] as RegExp);
    expect(text("HO3-007").text).toContain(listed("HO3-007").name);
  });
});

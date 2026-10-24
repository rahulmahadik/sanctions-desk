import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBank, isIso2, TABLES, type TableRows } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { assessNote, documentaryDateOfBirth, documentNumberSpan, normaliseDocumentNumber } from "../src/index.js";

/**
 * The fourth held-out set was written from the written definitions before any system output on it was seen. This
 * pins its file hash and the hash of the rows it points at, so a change after the hashes were recorded in
 * eval/cases/README.md fails here, and checks the labels against the definitions and the documentary evidence
 * standard as written: every clear is reachable, meets the standard and cites a document that is on the customer's
 * own identifier rows; every risk carries its relationship in text.
 */
const FROZEN_SHA256 = "de43651d416be5afb432498e114852fe113c0532146cc7d926ca212efd7753ed";
const FILE = "eval/cases/heldout4.json";
/** The case file names the rows; this pins the rows themselves (the text the labels were written against). */
const ROWS_SHA256 = "1744fe66c69a6618ead4c482b93d142ffac568bd3568d34f5ae35726f07a2571";

function sampleTables(): TableRows {
  const dir = resolveProjectPath("data/sample");
  const tables: Record<string, unknown[]> = {};
  for (const [name, schema] of Object.entries(TABLES)) {
    tables[name] = schema.array().parse(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  }
  return tables as unknown as TableRows;
}

describe("the fourth held-out set", () => {
  const sample = sampleTables();
  const snapshots = (
    JSON.parse(readFileSync(resolveProjectPath("data/sample/manifest.json"), "utf8")) as {
      snapshots: Array<{ snapshot_id: string }>;
    }
  ).snapshots.map((s) => s.snapshot_id);
  const bank = buildBank(sample, snapshots);
  const t = bank.tablesWithHeldout4;
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
      .map((name) => [name, (all[name] ?? []).filter((r) => /^[A-Z]+-L\d/.test(String(Object.values(r)[0])))]);
    expect(createHash("sha256").update(JSON.stringify(rows)).digest("hex")).toBe(ROWS_SHA256);
  });

  it("matches what the builder produces", () => {
    expect(JSON.stringify(bank.heldout4)).toBe(JSON.stringify(frozen.cases));
    expect(frozen.cases.map((c) => c.case_id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `HO4-${String(i + 1).padStart(3, "0")}`),
    );
  });

  const caseOf = (id: string) => {
    const c = bank.heldout4.find((x) => x.case_id === id);
    if (!c) throw new Error(`no case ${id}`);
    return c;
  };
  const paymentOf = (id: string) =>
    t.payment.find((p) => p.payment_id === t.alert.find((a) => a.alert_id === caseOf(id).alert_id)?.payment_id);
  const customerOf = (id: string) => t.customer.find((r) => r.customer_id === caseOf(id).customer_id);
  const identifiersOf = (id: string) =>
    t.customer_identifier.filter((r) => r.customer_id === caseOf(id).customer_id).map((r) => r.id_number);
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
      ids: sample.list_identifier
        .filter((x) => x.entry_id === entryId)
        .map((x) => normaliseDocumentNumber(x.id_number)),
    };
  };
  const conflictsWithEvery = (dob: string, dobs: ReturnType<typeof listed>["dobs"]) =>
    dobs.length > 0 &&
    dobs.every((d) =>
      d.dob_precision === "range"
        ? dob < (d.range_from ?? "") || dob > (d.range_to ?? "")
        : d.dob_precision === "year"
          ? dob.slice(0, 4) !== d.dob_value
          : d.dob_precision === "month"
            ? dob.slice(0, 7) !== d.dob_value
            : dob !== d.dob_value,
    );

  const RISKS = ["HO4-001", "HO4-002", "HO4-003", "HO4-004", "HO4-005", "HO4-006"];
  const CLEARS = ["HO4-007", "HO4-008", "HO4-009", "HO4-010", "HO4-011", "HO4-012"];
  const RULES_WOULD_CLOSE = ["HO4-001", "HO4-002", "HO4-003"];

  it("splits into 6 risks and 6 clears, with a close a miss on every risk and a block a miss on every clear", () => {
    const by = (expected: string) => frozen.cases.filter((c) => c.expected === expected).map((c) => c.case_id);
    expect(by("ESCALATE_L2")).toEqual(RISKS);
    expect(by("CLOSE_FALSE_POSITIVE")).toEqual(CLEARS);
    for (const c of frozen.cases) {
      if (c.expected === "CLOSE_FALSE_POSITIVE") {
        expect(c.acceptable, c.case_id).toEqual([]);
        expect(c.must_not, c.case_id).toEqual(["RECOMMEND_BLOCK"]);
      } else {
        // Every risk states its relationship as a fact, so asking for more is not an acceptable answer here.
        expect(c.acceptable, c.case_id).toEqual([]);
        expect(c.must_not, c.case_id).toEqual(["CLOSE_FALSE_POSITIVE"]);
      }
    }
  });

  it("states each risk's relationship to the listed party in the text, naming the listed party in full", () => {
    const relationship: Record<string, RegExp> = {
      "HO4-001": /\brun for her uncle, valeriy igorevich limarenko, who lives abroad\b/i,
      "HO4-002": /\bnominee-gesellschafter\b.*\bhält die anteile für vladislav vladimirovich sviblov\b/i,
      "HO4-003": /\bbefore that he was known as siddhartha dhar\b/i,
      "HO4-004": /\bdirector \(since 2019\) of transatlantic partners pte\. ltd\./i,
      "HO4-005": /\best contrôlée, via une holding au panama, par ramon alonso carrizalez rengifo\b/i,
      "HO4-006": /\bsole authorised signatory\b.*\bpower of attorney\b.*: rustam ilmirovich temirgaliev\b/i,
    };
    for (const id of RISKS) {
      const note = text(id).text ?? "";
      expect(note, id).toMatch(relationship[id] as RegExp);
      const tokens = listed(id).name.toLowerCase().split(/\s+/);
      for (const token of tokens) expect(note.toLowerCase(), `${id}: ${token}`).toContain(token);
    }
    expect(caseOf("HO4-005").alert_type).toBe("payment");
    const languages = RISKS.filter((id) => caseOf(id).edge_cases.includes("non_english_text"));
    expect(languages).toEqual(["HO4-002", "HO4-005"]);
    const atDistance = RISKS.filter((id) => caseOf(id).edge_cases.includes("relation_word_at_distance"));
    expect(atDistance).toEqual(expect.arrayContaining(["HO4-001", "HO4-004"]));
  });

  it("gives no risk case text that meets the standard, so none of them could be cleared by it", () => {
    for (const id of RISKS) expect(assessNote(text(id)).documentary, id).toBe(false);
  });

  it("gives HO4-001, HO4-002 and HO4-003 structured fields that alone meet the false-positive definition", () => {
    for (const id of RULES_WOULD_CLOSE) {
      const customer = customerOf(id);
      const l = listed(id);
      expect(caseOf(id).edge_cases, id).toContain("rules_would_close");
      expect(
        l.dobs.map((d) => d.dob_precision),
        id,
      ).toEqual(["day"]);
      expect(customer?.date_of_birth, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(conflictsWithEvery(customer?.date_of_birth ?? "", l.dobs), id).toBe(true);
      expect(l.nationalities.length, id).toBeGreaterThan(0);
      expect(l.nationalities, id).not.toContain(customer?.nationality);
      expect(
        identifiersOf(id).filter((n) => l.ids.includes(normaliseDocumentNumber(n))),
        id,
      ).toEqual([]);
    }
  });

  it("gives every clear text that meets the documentary standard", () => {
    expect(CLEARS.map((id) => assessNote(text(id)))).toEqual(CLEARS.map(() => ({ documentary: true, missing: [] })));
  });

  it("puts the document number each clear's note cites on that customer's identifier rows", () => {
    for (const id of CLEARS) {
      const cited = documentNumberSpan(text(id).text)?.value;
      expect(cited, id).toBeTruthy();
      const own = identifiersOf(id).map(normaliseDocumentNumber);
      expect(own, id).toContain(normaliseDocumentNumber(cited ?? ""));
      // The number on the customer record is the very string the note carries, not a near copy.
      expect(identifiersOf(id), id).toContain(cited);
    }
  });

  it("makes every clear reachable: a customer alert, no birth date on record, answered by a documentary labelled birth date that conflicts", () => {
    for (const id of CLEARS) {
      expect(caseOf(id).alert_type, id).toBe("customer");
      const customer = customerOf(id);
      const l = listed(id);
      expect(customer?.customer_type, id).toBe("individual");
      expect(customer?.date_of_birth, id).toBeNull();
      expect(isIso2(customer?.nationality ?? ""), id).toBe(true);
      const stated = documentaryDateOfBirth(customer?.notes);
      expect(stated, id).not.toBeNull();
      expect(conflictsWithEvery(stated?.value ?? "", l.dobs), id).toBe(true);
      expect(l.nationalities, id).not.toContain(customer?.nationality);
      expect(
        identifiersOf(id).filter((n) => l.ids.includes(normaliseDocumentNumber(n))),
        id,
      ).toEqual([]);
      expect(
        t.payment.filter((p) =>
          t.account.some((a) => a.account_id === p.account_id && a.customer_id === customer?.customer_id),
        ),
      ).toEqual([]);
    }
  });

  it("puts words that only sound like a relationship, or the listed name in a check that found no match, in the clears", () => {
    const wording: Record<string, RegExp> = {
      "HO4-007": /father's name as printed/i,
      "HO4-008": /director of studies/i,
      "HO4-009": /nominee for an award/i,
      "HO4-010": /sister branch/i,
      "HO4-011": /name check against .* not the same person/i,
      "HO4-012": /a company owned by the customer himself/i,
    };
    for (const id of CLEARS) expect(text(id).text, id).toMatch(wording[id] as RegExp);
    expect(text("HO4-011").text).toContain(listed("HO4-011").name);
  });
});

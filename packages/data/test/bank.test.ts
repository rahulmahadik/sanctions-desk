import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  applyDeltaToSample,
  BANKDB_TABLE_ORDER,
  buildBank,
  compareParty,
  customerProfileFromRows,
  DEFAULT_BANK_OPTIONS,
  DELTA_LABEL,
  EXAM_GROUP_SIZES,
  groupByEntry,
  listedPartyFromRows,
  renderBankdbLoad,
  renderBankdbSchema,
  SYNTHETIC_LABEL,
  SYNTHETIC_TABLES,
  validateBank,
  writeBank,
  writeExam,
} from "../src/index.js";
import { tempDir } from "./helpers.js";
import { loadSampleTables } from "./sample-helpers.js";

const list = loadSampleTables();
const snapshotIds = ["a", "b"];
const bank = buildBank(list, snapshotIds);
const after = applyDeltaToSample(list, bank.delta, DELTA_LABEL);
const T = { nameSimilarity: 0.85 };

function comparisonFor(caseId: string, tables = list) {
  const c = bank.cases.find((x) => x.case_id === caseId);
  if (!c?.customer_id || !c.entry_id) throw new Error(`${caseId} has no alert`);
  const customer = bank.tables.customer.find((r) => r.customer_id === c.customer_id);
  if (!customer) throw new Error("no customer");
  const ids = bank.tables.customer_identifier.filter((r) => r.customer_id === c.customer_id);
  const entry = tables.list_entry.find((e) => e.entry_id === c.entry_id);
  if (!entry) throw new Error("no entry");
  const by = (rows: readonly { entry_id: string }[]) => groupByEntry(rows as never).get(c.entry_id as string) ?? [];
  const party = listedPartyFromRows({
    entry,
    aliases: by(tables.list_alias),
    dobs: by(tables.list_dob),
    countries: by(tables.list_country),
    identifiers: by(tables.list_identifier),
  });
  return compareParty(customerProfileFromRows(customer, ids), party, T);
}

const inGroup = (group: string) => bank.cases.filter((c) => c.group === group);

describe("the synthetic bank", () => {
  it("is deterministic for a seed and different for another", () => {
    expect(buildBank(list, snapshotIds)).toEqual(bank);
    const other = buildBank(list, snapshotIds, {
      ...DEFAULT_BANK_OPTIONS,
      seed: "another-seed",
      backgroundCustomers: 20,
    });
    expect(other.tables.customer.map((c) => c.full_name)).not.toEqual(bank.tables.customer.map((c) => c.full_name));
  });

  it("has the 70 exam cases in the planned groups, with unique ids", () => {
    expect(bank.cases).toHaveLength(70);
    for (const [group, size] of Object.entries(EXAM_GROUP_SIZES)) expect(inGroup(group), group).toHaveLength(size);
    expect(new Set(bank.cases.map((c) => c.case_id)).size).toBe(70);
    expect(new Set(bank.cases.flatMap((c) => (c.entry_id ? [c.entry_id] : []))).size).toBeGreaterThan(50);
  });

  it("is internally consistent, labelled synthetic, and carries a few hundred customers", () => {
    expect(validateBank(bank.tables, list, bank.cases)).toEqual([]);
    expect(bank.manifest.label).toBe(SYNTHETIC_LABEL);
    expect(bank.tables.customer.every((c) => c.data_origin === "synthetic")).toBe(true);
    expect(bank.tables.customer.length).toBeGreaterThan(280);
    expect(bank.tables.payment.length).toBeGreaterThan(300);
    expect(bank.tables.beneficial_owner.length).toBeGreaterThanOrEqual(20);
    expect(bank.tables.disposition).toHaveLength(13);
  });

  it("covers the planted edge cases", () => {
    const tags = new Set(bank.cases.flatMap((c) => c.edge_cases));
    for (const tag of [
      "transliteration",
      "name_order",
      "initials",
      "honorifics",
      "diacritics",
      "hyphens",
      "common_name",
      "homoglyph",
      "company_suffix",
      "partial_dob",
      "dob_conflict",
      "exactly_50",
      "below_50_49_9",
      "split_25_25",
      "chain",
      "depth_limit",
      "circular",
      "missing_pct",
      "entry_updated_reopen",
      "duplicate_alerts",
      "injection",
      "tipping_off",
      "jurisdiction",
    ]) {
      expect(tags.has(tag), tag).toBe(true);
    }
    const pct = (id: string) =>
      bank.tables.beneficial_owner.filter((o) => o.owner_party_id === id).map((o) => o.ownership_pct);
    const exact50 = bank.cases.find((c) => c.kind === "ho_direct_50");
    const below = bank.cases.find((c) => c.kind === "ob_49_9");
    const missing = bank.cases.find((c) => c.kind === "ob_missing_pct");
    expect(pct(exact50?.entry_id ?? "")).toContain("50");
    expect(pct(below?.entry_id ?? "")).toContain("49.9");
    expect(pct(missing?.entry_id ?? "")).toContain(null);
    const circular = bank.cases.find((c) => c.kind === "ho_circular");
    const owned = new Set(
      bank.tables.beneficial_owner
        .filter((o) => o.owned_party_id === circular?.customer_id)
        .map((o) => o.owner_party_id),
    );
    expect(
      [...owned].some((id) =>
        bank.tables.beneficial_owner.some((o) => o.owned_party_id === id && o.owner_party_id === circular?.customer_id),
      ),
    ).toBe(true);
  });

  it("plants homoglyph, long-text, injection and watched-jurisdiction data", () => {
    expect(
      bank.tables.customer.some(
        (c) => /\p{Script=Latin}/u.test(c.full_name) && /\p{Script=Cyrillic}/u.test(c.full_name),
      ),
    ).toBe(true);
    expect(
      bank.tables.payment.some(
        (p) => /\p{Script=Cyrillic}/u.test(p.counterparty_name) && /\p{Script=Latin}/u.test(p.counterparty_name),
      ),
    ).toBe(true);
    expect(bank.tables.payment.some((p) => (p.payment_reference ?? "").length >= 400)).toBe(true);
    expect(bank.tables.payment.some((p) => ["CU", "IR", "KP"].includes(p.counterparty_country))).toBe(true);
    expect(bank.tables.customer.some((c) => /ignore all previous instructions/i.test(c.notes ?? ""))).toBe(true);
    expect(
      bank.tables.payment.filter((p) => /ignore previous instructions|<\/system>/i.test(p.payment_reference ?? "")),
    ).toHaveLength(2);
    expect(bank.tables.customer.some((c) => c.date_of_birth === null && c.customer_type === "individual")).toBe(true);
  });
});

describe("every label agrees with the deterministic matcher", () => {
  const customerCases = (group: string) => inGroup(group).filter((c) => c.alert_type === "customer" && c.customer_id);

  it("false positives meet the approved definition (except the watched-jurisdiction case)", () => {
    for (const c of inGroup("false_positive")) {
      const r = comparisonFor(c.case_id);
      expect(r.definitions.false_positive, `${c.case_id} ${c.kind}`).toBe(true);
      expect(r.definitions.true_match, c.kind).toBe(false);
    }
  });

  it("customer true matches meet the true match definition or match a document", () => {
    for (const c of customerCases("true_match").filter((x) => !x.kind.startsWith("tm_payment"))) {
      const r = comparisonFor(c.case_id);
      expect(r.definitions.true_match || r.identifiers.status === "match", `${c.case_id} ${c.kind}`).toBe(true);
    }
  });

  it("the disguised name is seen through and flagged", () => {
    const c = bank.cases.find((x) => x.kind === "tm_homoglyph");
    const r = comparisonFor(c?.case_id ?? "");
    expect(r.name.homoglyph).toBe(true);
    expect(r.name.score).toBeGreaterThanOrEqual(0.95);
  });

  it("transliteration cases line up", () => {
    for (const c of inGroup("transliteration")) {
      const r = comparisonFor(c.case_id);
      if (c.expected === "ESCALATE_L2") expect(r.definitions.true_match, c.kind).toBe(true);
      else expect(r.definitions.false_positive, c.kind).toBe(true);
    }
  });

  it("missing-data cases are missing something a decision needs", () => {
    const noDob = comparisonFor(bank.cases.find((c) => c.kind === "md_no_dob_0")?.case_id ?? "");
    expect(noDob.dob.status).toBe("missing_customer");
    expect(noDob.definitions).toEqual({ true_match: false, false_positive: false, counterparty_match: false });
    const bad = bank.tables.customer.find(
      (c) => c.customer_id === bank.cases.find((x) => x.kind === "md_bad_nationality")?.customer_id,
    );
    expect(bad?.nationality).toBe("XX");
  });

  it("earlier clearances still hold when the entry is unchanged, and fail after the list update", () => {
    for (const c of inGroup("previously_cleared_unchanged")) {
      expect(comparisonFor(c.case_id).definitions.false_positive, c.kind).toBe(true);
      const entryHash = list.list_entry.find((e) => e.entry_id === c.entry_id)?.content_hash;
      const disposition = bank.tables.disposition.find((d) => d.customer_id === c.customer_id);
      expect(disposition?.entry_content_hash).toBe(entryHash);
      expect(after.list_entry.find((e) => e.entry_id === c.entry_id)?.content_hash).toBe(entryHash);
    }
    for (const c of inGroup("previously_cleared_changed")) {
      expect(comparisonFor(c.case_id).definitions.true_match, `${c.kind} before`).toBe(false);
      const disposition = bank.tables.disposition.find((d) => d.customer_id === c.customer_id);
      const now = after.list_entry.find((e) => e.entry_id === c.entry_id);
      expect(now?.content_hash, c.kind).not.toBe(disposition?.entry_content_hash);
      expect(now?.snapshot_id).toContain("+synthetic-");
      const r = comparisonFor(c.case_id, after);
      expect(r.definitions.true_match || r.identifiers.status === "match", `${c.kind} after`).toBe(true);
    }
  });

  it("ownership alerts point at the listed owner on the register", () => {
    for (const c of [...inGroup("hidden_ownership"), ...inGroup("ownership_below")]) {
      const alert = bank.tables.alert.find((a) => a.alert_id === c.alert_id);
      expect(alert?.alert_source, c.kind).toBe("ownership");
      expect(
        bank.tables.beneficial_owner.some((o) => o.owner_party_id === c.entry_id),
        c.kind,
      ).toBe(true);
    }
  });

  it("every case that can run says what must never happen", () => {
    for (const c of bank.cases.filter((x) => x.expected === "ESCALATE_L2" || x.expected === "NEED_MORE_INFO")) {
      expect(c.must_not, c.kind).toContain("CLOSE_FALSE_POSITIVE");
    }
    expect(inGroup("tipping_off").every((c) => c.draft !== undefined && c.expected === "DRAFT_BLOCKED")).toBe(true);
  });
});

describe("delisting extras", () => {
  it("escalate two customers before; the update removes one listed entry and leaves the other alone", () => {
    const escalated = bank.tables.disposition.filter((d) => d.decision === "ESCALATE_L2");
    expect(escalated).toHaveLength(2);
    const removed = bank.delta.filter((op) => op.op === "remove_entry").map((op) => op.entry_id);
    expect(removed).toHaveLength(1);
    expect(escalated.map((d) => d.entry_id)).toContain(removed[0]);
    expect(after.list_entry.some((e) => e.entry_id === removed[0])).toBe(false);
    const kept = escalated.find((d) => d.entry_id !== removed[0]);
    expect(after.list_entry.find((e) => e.entry_id === kept?.entry_id)?.content_hash).toBe(kept?.entry_content_hash);
    expect(bank.tables.alert.filter((a) => a.status === "escalated")).toHaveLength(2);
  });
});

describe("validateBank and the files", () => {
  it("reports broken references", () => {
    const broken = structuredClone(bank.tables);
    const at = <T>(rows: T[], i: number): T => {
      const found = rows[i];
      if (!found) throw new Error("missing row");
      return found;
    };
    broken.alert[0] = { ...at(broken.alert, 0), customer_id: "CUST-9999" };
    broken.payment[0] = { ...at(broken.payment, 0), account_id: "ACC-99999" };
    broken.disposition[0] = { ...at(broken.disposition, 0), alert_id: "ALR-9999" };
    broken.customer.push(at(broken.customer, 0));
    const problems = validateBank(broken, list, bank.cases);
    expect(problems.join("\n")).toContain("unknown customer");
    expect(problems.join("\n")).toContain("not the customer's");
    expect(problems.join("\n")).toContain("unknown alert");
    expect(problems.join("\n")).toContain("duplicate ids");
  });

  it("writes json and csv per table, the list update, the manifest and the exam file", () => {
    const dir = tempDir();
    writeBank(dir, bank);
    const examFile = join(dir, "exam", "exam.json");
    writeExam(examFile, bank);
    expect(JSON.parse(readFileSync(join(dir, "customer.json"), "utf8"))).toHaveLength(bank.tables.customer.length);
    expect(readFileSync(join(dir, "payment.csv"), "utf8").split("\n")[0]).toContain("payment_id,customer_id");
    expect(JSON.parse(readFileSync(join(dir, "list-delta.json"), "utf8")).ops).toHaveLength(6);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).exam.cases).toBe(70);
    expect(JSON.parse(readFileSync(examFile, "utf8")).cases).toHaveLength(70);
  });
});

describe("the Postgres schema", () => {
  it("is generated from the row definitions and the committed scripts are current", () => {
    expect(readFileSync(resolveProjectPath("docker/bankdb/init/01_schema.sql"), "utf8")).toBe(renderBankdbSchema());
    expect(readFileSync(resolveProjectPath("docker/bankdb/init/02_load.sql"), "utf8")).toBe(renderBankdbLoad());
  });

  it("has one column per row field, in order, and loads tables after the tables they point at", () => {
    const schema = renderBankdbSchema();
    for (const name of BANKDB_TABLE_ORDER) {
      const block = schema.slice(schema.indexOf(`CREATE TABLE ${name} (`)).split(");")[0] ?? "";
      const columns = [...block.matchAll(/^ {2}(\w+) /gm)].map((m) => m[1]);
      expect(columns, name).toEqual(Object.keys(SYNTHETIC_TABLES[name].shape));
    }
    expect(BANKDB_TABLE_ORDER.indexOf("payment")).toBeLessThan(BANKDB_TABLE_ORDER.indexOf("alert"));
    expect(BANKDB_TABLE_ORDER.indexOf("customer")).toBeLessThan(BANKDB_TABLE_ORDER.indexOf("account"));
  });
});

describe("the held-out rows", () => {
  it("are kept out of the main tables, so adding the set changes no committed row", () => {
    expect(bank.tables.customer.some((c) => c.customer_id.startsWith("CUST-H"))).toBe(false);
    expect(bank.tablesWithHeldout.customer.some((c) => c.customer_id.startsWith("CUST-H"))).toBe(true);
    expect(bank.manifest.counts.customer).toBe(bank.tables.customer.length);
    const main = new Set(bank.tables.customer.map((c) => JSON.stringify(c)));
    expect(bank.tablesWithHeldout.customer.filter((c) => main.has(JSON.stringify(c)))).toHaveLength(main.size);
  });

  it("build the same bank every time", () => {
    const again = buildBank(list, snapshotIds);
    expect(JSON.stringify(again.tablesWithHeldout)).toBe(JSON.stringify(bank.tablesWithHeldout));
    expect(JSON.stringify(again.heldout)).toBe(JSON.stringify(bank.heldout));
  });
});

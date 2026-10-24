import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeltaOp } from "../delta.js";
import { customerProfileFromRows } from "../matching/adapters.js";
import { compareParty } from "../matching/compare.js";
import { shortHash, type TableRows } from "../model.js";
import { csvOf } from "../snapshot.js";
import { BankBuilder, CURRENT_TIME, EXAM_GROUP_SIZES, type ExamCase } from "./builder.js";
import { addDelistingExtras, buildExamCases } from "./cases.js";
import { buildClearingCases, buildHeldoutCases, heldoutCaseIds } from "./heldout.js";
import { buildHeldout2Cases, heldout2CaseIds } from "./heldout2.js";
import { buildHeldout3Cases, heldout3CaseIds } from "./heldout3.js";
import { buildHeldout4Cases, heldout4CaseIds } from "./heldout4.js";
import {
  emptySyntheticTables,
  SYNTHETIC_LABEL,
  SYNTHETIC_TABLE_NAMES,
  SYNTHETIC_TABLES,
  type SyntheticTableName,
  type SyntheticTables,
} from "./model.js";
import { companyName, personName } from "./names.js";
import { createRng } from "./random.js";
import { candidatesFrom } from "./scenarios.js";

/** The seeded synthetic bank: customers, owners, payments and alerts, with the 70 exam cases planted in it. */

export interface BankOptions {
  seed: string;
  backgroundCustomers: number;
  /** Alerts raised for background customers whose name scores at least this against a listed name. */
  backgroundAlertThreshold: number;
  maxBackgroundAlerts: number;
}

export const DEFAULT_BANK_OPTIONS: BankOptions = {
  seed: "sanctions-desk-bank-1",
  backgroundCustomers: 240,
  backgroundAlertThreshold: 0.9,
  maxBackgroundAlerts: 12,
};

export interface SyntheticBank {
  /** The rows of the main exam and the background. This is what `data/synthetic/` holds. */
  tables: SyntheticTables;
  /** The same rows plus those of the held-out set, which are loaded only when the set is run. */
  tablesWithHeldout: SyntheticTables;
  /** The rows of the main exam, the first held-out set and the second, in that order. */
  tablesWithHeldout2: SyntheticTables;
  /** The rows of the main exam and the three held-out sets, in that order. */
  tablesWithHeldout3: SyntheticTables;
  /** The rows of the main exam and the four held-out sets, in that order. */
  tablesWithHeldout4: SyntheticTables;
  cases: ExamCase[];
  /** The frozen held-out set (HO-001 and up). Its rows are in `tablesWithHeldout`, with ids that carry an H. */
  heldout: ExamCase[];
  /** The second frozen held-out set (HO2-001 and up). Its rows are in `tablesWithHeldout2`, with ids that carry a J. */
  heldout2: ExamCase[];
  /** The third frozen held-out set (HO3-001 and up). Its rows are in `tablesWithHeldout3`, with ids that carry a K. */
  heldout3: ExamCase[];
  /** The fourth frozen held-out set (HO4-001 and up). Its rows are in `tablesWithHeldout4`, with ids that carry an L. */
  heldout4: ExamCase[];
  /** Edits that turn the committed list into the later list the exam runs against. */
  delta: DeltaOp[];
  manifest: BankManifest;
}

export interface BankManifest {
  label: string;
  seed: string;
  counts: Record<string, number>;
  exam: { cases: number; groups: Record<string, number> };
  list_snapshot_ids: string[];
  delta: { label: string; ops: number };
}

export const DELTA_LABEL =
  "Synthetic list update for demonstration: a few real entries are edited so earlier clearances can be re-checked. Not a published list.";

const HOME_COUNTRIES = ["GB", "DE", "SG", "AE", "CH", "NL", "FR", "HK", "ES", "IT", "SE", "IE"];
const WATCHED = ["CU", "IR", "KP"];
const NOTES = [
  "Onboarded in branch.",
  "Source of funds documented.",
  "Annual review completed.",
  "Relationship manager changed.",
  "Address verified by utility bill.",
];
const REFERENCES = [
  "Invoice for goods",
  "Consulting services",
  "Rent",
  "Salary",
  "Equipment purchase",
  "Loan repayment",
];
const pad = (n: number) => String(n).padStart(2, "0");

function homoglyphed(name: string): string {
  const swap: Record<string, string> = { a: "а", e: "е", o: "о", p: "р", c: "с" };
  return name.replace(/[aeopc]/g, (m) => swap[m] ?? m);
}

function addBackgroundCustomer(b: BankBuilder, i: number): void {
  const { rng } = b;
  {
    const isCompany = i % 6 === 5;
    const home = rng.pick(HOME_COUNTRIES);
    const customer = isCompany
      ? b.customer({
          customer_type: "company",
          full_name: companyName(rng),
          nationality: home,
          residence_country: home,
        })
      : b.customer({
          customer_type: "individual",
          full_name: personName(rng),
          date_of_birth: `${rng.int(1945, 2003)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`,
          nationality: rng.pick(HOME_COUNTRIES),
          residence_country: home,
          risk_rating: rng.pick(["low", "low", "medium", "high"] as const),
        });
    if (rng.chance(0.15)) customer.notes = rng.pick(NOTES);
    b.identifier(
      customer.customer_id,
      isCompany ? "registration" : "passport",
      `${isCompany ? "REG" : "P"}${rng.int(1000000, 9999999)}`,
      home,
    );
    if (rng.chance(0.2))
      b.alias(
        customer.customer_id,
        isCompany ? `${customer.full_name} (trading)` : personName(rng),
        isCompany ? "trading" : "former",
      );
    if (rng.chance(0.15)) b.account(customer.customer_id);
    const payments = rng.pick([0, 1, 1, 2, 3]);
    for (let p = 0; p < payments; p += 1) {
      const counterpartyIsCompany = rng.chance(0.5);
      b.payment({
        customer_id: customer.customer_id,
        counterparty_name: counterpartyIsCompany ? companyName(rng) : personName(rng),
        counterparty_country: rng.chance(0.03) ? rng.pick(WATCHED) : rng.pick(HOME_COUNTRIES),
        amount: `${rng.int(100, 250000)}.${pad(rng.int(0, 99))}`,
        payment_reference: rng.pick(REFERENCES),
        value_date: `2026-10-${pad(rng.int(20, 28))}`,
      });
    }
  }
}

/** Planted payment oddities: disguised names, very long references, and watched jurisdictions. */
function plantPaymentOddities(b: BankBuilder): void {
  const { rng } = b;
  const customers = b.tables.customer.filter((c) => c.customer_id.startsWith("CUST-"));
  const pick = () => rng.pick(customers);
  for (let i = 0; i < 4; i += 1) {
    b.payment({
      customer_id: pick().customer_id,
      counterparty_name: homoglyphed(personName(rng)),
      counterparty_country: rng.pick(HOME_COUNTRIES),
      payment_reference: "Services",
    });
  }
  for (let i = 0; i < 3; i += 1) {
    b.payment({
      customer_id: pick().customer_id,
      counterparty_name: companyName(rng),
      counterparty_country: rng.pick(HOME_COUNTRIES),
      payment_reference: `Long reference ${"x".repeat(420)}`.slice(0, 500),
    });
  }
  for (const country of WATCHED) {
    b.payment({
      customer_id: pick().customer_id,
      counterparty_name: companyName(rng),
      counterparty_country: country,
      payment_reference: "Trade settlement",
    });
  }
}

function addBackground(b: BankBuilder, count: number): void {
  for (let i = 0; i < count; i += 1) addBackgroundCustomer(b, i);
  plantPaymentOddities(b);
}

/** Raise alerts the way a plain screening engine would: best fuzzy name match above a threshold. */
function addBackgroundAlerts(b: BankBuilder, exam: ReadonlySet<string>, options: BankOptions): void {
  const raised: Array<{ score: number; customerId: string; index: number }> = [];
  const customers = b.tables.customer.filter((c) => !exam.has(c.customer_id));
  for (const customer of customers) {
    const profile = customerProfileFromRows(customer, []);
    let best: { score: number; index: number } | undefined;
    b.candidates.forEach((candidate, index) => {
      const kindOk = (candidate.party.kind === "individual") === (customer.customer_type === "individual");
      if (!kindOk) return;
      const score = compareParty(profile, candidate.party, { nameSimilarity: 0.85 }).name.score;
      if (!best || score > best.score) best = { score, index };
    });
    if (best && best.score >= options.backgroundAlertThreshold) {
      raised.push({ score: best.score, customerId: customer.customer_id, index: best.index });
    }
  }
  raised.sort((a, c) => c.score - a.score || a.customerId.localeCompare(c.customerId));
  for (const hit of raised.slice(0, options.maxBackgroundAlerts)) {
    const customer = customers.find((c) => c.customer_id === hit.customerId);
    const candidate = b.candidates[hit.index];
    if (customer && candidate) b.alert({ customer, candidate, source: "customer_name" });
  }
}

interface Known {
  customers: ReadonlySet<string>;
  entries: ReadonlySet<string>;
  alerts: ReadonlySet<string>;
  payments: ReadonlySet<string>;
  accounts: ReadonlyMap<string, string>;
}

function duplicateIds(tables: SyntheticTables): string[] {
  const groups: Array<[string, string[]]> = [
    ["customer", tables.customer.map((r) => r.customer_id)],
    ["customer_identifier", tables.customer_identifier.map((r) => r.identifier_id)],
    ["account", tables.account.map((r) => r.account_id)],
    ["alert", tables.alert.map((r) => r.alert_id)],
    ["payment", tables.payment.map((r) => r.payment_id)],
    ["beneficial_owner", tables.beneficial_owner.map((r) => r.ownership_id)],
    ["disposition", tables.disposition.map((r) => r.disposition_id)],
  ];
  return groups.filter(([, ids]) => new Set(ids).size !== ids.length).map(([name]) => `${name} has duplicate ids`);
}

function ownedByCustomers(tables: SyntheticTables, known: Known): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  for (const r of tables.customer_identifier)
    need(known.customers.has(r.customer_id), `identifier ${r.identifier_id}: unknown customer`);
  for (const r of tables.customer_alias)
    need(known.customers.has(r.customer_id), `alias ${r.alias_id}: unknown customer`);
  for (const r of tables.account) need(known.customers.has(r.customer_id), `account ${r.account_id}: unknown customer`);
  for (const r of tables.payment) {
    need(known.accounts.get(r.account_id) === r.customer_id, `payment ${r.payment_id}: account is not the customer's`);
  }
  return problems;
}

function alertsAndDecisions(tables: SyntheticTables, known: Known): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  for (const r of tables.alert) {
    need(known.customers.has(r.customer_id), `alert ${r.alert_id}: unknown customer`);
    need(known.entries.has(r.entry_id), `alert ${r.alert_id}: unknown list entry`);
    need(r.payment_id === null || known.payments.has(r.payment_id), `alert ${r.alert_id}: unknown payment`);
  }
  for (const r of tables.disposition) {
    need(known.alerts.has(r.alert_id), `disposition ${r.disposition_id}: unknown alert`);
    need(known.entries.has(r.entry_id), `disposition ${r.disposition_id}: unknown list entry`);
  }
  return problems;
}

function ownershipLinks(tables: SyntheticTables, known: Known): string[] {
  const problems: string[] = [];
  for (const r of tables.beneficial_owner) {
    if (r.owned_party_kind === "customer" && !known.customers.has(r.owned_party_id)) {
      problems.push(`ownership ${r.ownership_id}: unknown owned customer`);
    }
    if (r.owner_party_kind === "listed" && !known.entries.has(r.owner_party_id)) {
      problems.push(`ownership ${r.ownership_id}: unknown listed owner`);
    }
    if (r.owner_party_kind === "customer" && !known.customers.has(r.owner_party_id)) {
      problems.push(`ownership ${r.ownership_id}: unknown owner customer`);
    }
  }
  return problems;
}

function examLinks(cases: readonly ExamCase[], known: Known): string[] {
  const problems: string[] = [];
  const ids = cases.map((c) => c.case_id);
  if (new Set(ids).size !== ids.length) problems.push("exam case has duplicate ids");
  for (const c of cases) {
    if (c.alert_id && !known.alerts.has(c.alert_id)) problems.push(`${c.case_id}: unknown alert`);
    if (c.customer_id && !known.customers.has(c.customer_id)) problems.push(`${c.case_id}: unknown customer`);
    if (c.entry_id && !known.entries.has(c.entry_id)) problems.push(`${c.case_id}: unknown list entry`);
  }
  return problems;
}

export function validateBank(tables: SyntheticTables, list: TableRows, cases: readonly ExamCase[]): string[] {
  const known: Known = {
    customers: new Set(tables.customer.map((r) => r.customer_id)),
    entries: new Set(list.list_entry.map((e) => e.entry_id)),
    alerts: new Set(tables.alert.map((r) => r.alert_id)),
    payments: new Set(tables.payment.map((r) => r.payment_id)),
    accounts: new Map(tables.account.map((a) => [a.account_id, a.customer_id])),
  };
  return [
    ...duplicateIds(tables),
    ...ownedByCustomers(tables, known),
    ...alertsAndDecisions(tables, known),
    ...ownershipLinks(tables, known),
    ...examLinks(cases, known),
  ];
}

export function buildBank(
  list: TableRows,
  listSnapshotIds: readonly string[],
  options: BankOptions = DEFAULT_BANK_OPTIONS,
): SyntheticBank {
  const rng = createRng(options.seed);
  const candidates = candidatesFrom(list);
  const hashes = new Map(list.list_entry.map((e) => [e.entry_id, { hash: e.content_hash, snapshot: e.snapshot_id }]));
  const tables = emptySyntheticTables();
  const b = new BankBuilder(rng, options.seed, candidates, tables, hashes);

  buildExamCases(b);
  addDelistingExtras(b);
  const examCustomers = new Set(tables.customer.map((c) => c.customer_id));
  addBackground(b, options.backgroundCustomers);
  addBackgroundAlerts(b, examCustomers, options);

  const mainTables = structuredClone(tables);

  // The held-out set: its own seed and id marker, built last, so no other row changes when it is added.
  const hb = new BankBuilder(
    createRng(`${options.seed}#heldout`),
    `${options.seed}#heldout`,
    candidates,
    tables,
    hashes,
    "H",
  );
  buildHeldoutCases(hb);
  buildClearingCases(hb);
  const heldout = heldoutCaseIds(hb.cases);
  const tablesWithHeldout = structuredClone(tables);

  // The second held-out set: built after the first, with its own seed and marker, and without reusing a listed party
  // that the first set used. The rows above are copied before it is added, so they do not change.
  const hb2 = new BankBuilder(
    createRng(`${options.seed}#heldout2`),
    `${options.seed}#heldout2`,
    candidates,
    tables,
    hashes,
    "J",
  );
  for (const entryId of hb.used) hb2.used.add(entryId);
  buildHeldout2Cases(hb2);
  const heldout2 = heldout2CaseIds(hb2.cases);
  const tablesWithHeldout2 = structuredClone(tables);

  // The third held-out set: built after the second, with its own seed and marker, and without reusing a listed party
  // that either earlier set used. The rows above are copied before it is added, so they do not change.
  const hb3 = new BankBuilder(
    createRng(`${options.seed}#heldout3`),
    `${options.seed}#heldout3`,
    candidates,
    tables,
    hashes,
    "K",
  );
  for (const entryId of [...hb.used, ...hb2.used]) hb3.used.add(entryId);
  // The third set names its listed parties outright, chosen against the default seed's earlier sets. With another seed
  // the earlier sets may pick one of them at random, so the third set is built for the default seed only.
  const thirdSet = options.seed === DEFAULT_BANK_OPTIONS.seed;
  if (thirdSet) buildHeldout3Cases(hb3);
  const heldout3 = thirdSet ? heldout3CaseIds(hb3.cases) : [];
  const tablesWithHeldout3 = structuredClone(tables);

  // The fourth held-out set: built after the third, with its own seed and marker, and without reusing a listed party
  // that the main exam or an earlier set used. Like the third set it names its listed parties outright, so it is
  // built for the default seed only. The rows above are copied before it is added, so they do not change.
  const hb4 = new BankBuilder(
    createRng(`${options.seed}#heldout4`),
    `${options.seed}#heldout4`,
    candidates,
    tables,
    hashes,
    "L",
  );
  for (const entryId of [...b.used, ...hb.used, ...hb2.used, ...hb3.used]) hb4.used.add(entryId);
  if (thirdSet) buildHeldout4Cases(hb4);
  const heldout4 = thirdSet ? heldout4CaseIds(hb4.cases) : [];

  const problems = [
    ...validateBank(tablesWithHeldout, list, [...b.cases, ...heldout]),
    ...validateBank(tablesWithHeldout2, list, [...b.cases, ...heldout, ...heldout2]),
    ...validateBank(tablesWithHeldout3, list, [...b.cases, ...heldout, ...heldout2, ...heldout3]),
    ...validateBank(tables, list, [...b.cases, ...heldout, ...heldout2, ...heldout3, ...heldout4]),
  ];
  if (problems.length > 0)
    throw new Error(`the synthetic bank is inconsistent:\n- ${problems.slice(0, 10).join("\n- ")}`);

  const groups: Record<string, number> = {};
  for (const c of b.cases) groups[c.group] = (groups[c.group] ?? 0) + 1;
  for (const [group, size] of Object.entries(EXAM_GROUP_SIZES)) {
    if (groups[group] !== size)
      throw new Error(`exam group ${group} has ${groups[group] ?? 0} cases, expected ${size}`);
  }

  return {
    tables: mainTables,
    tablesWithHeldout,
    tablesWithHeldout2,
    tablesWithHeldout3,
    tablesWithHeldout4: tables,
    cases: b.cases,
    heldout,
    heldout2,
    heldout3,
    heldout4,
    delta: b.delta,
    manifest: {
      label: SYNTHETIC_LABEL,
      seed: `${options.seed}#${shortHash(options.seed, JSON.stringify(b.cases.map((c) => c.kind)))}`,
      counts: Object.fromEntries(SYNTHETIC_TABLE_NAMES.map((n) => [n, mainTables[n].length])),
      exam: { cases: b.cases.length, groups },
      list_snapshot_ids: [...listSnapshotIds],
      delta: { label: DELTA_LABEL, ops: b.delta.length },
    },
  };
}

const columnsOf = (name: SyntheticTableName): string[] => Object.keys(SYNTHETIC_TABLES[name].shape);

export function writeBank(
  dir: string,
  bank: SyntheticBank,
  options: {
    includeHeldout?: boolean;
    includeHeldout2?: boolean;
    includeHeldout3?: boolean;
    includeHeldout4?: boolean;
  } = {},
): void {
  mkdirSync(dir, { recursive: true });
  // Each set's rows come after the earlier sets' rows, so asking for a later set includes the earlier ones.
  const tables = options.includeHeldout4
    ? bank.tablesWithHeldout4
    : options.includeHeldout3
      ? bank.tablesWithHeldout3
      : options.includeHeldout2
        ? bank.tablesWithHeldout2
        : options.includeHeldout
          ? bank.tablesWithHeldout
          : bank.tables;
  for (const name of SYNTHETIC_TABLE_NAMES) {
    const rows = tables[name] as object[];
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(rows)}\n`);
    writeFileSync(join(dir, `${name}.csv`), csvOf(columnsOf(name), rows));
  }
  writeFileSync(join(dir, "list-delta.json"), `${JSON.stringify({ label: DELTA_LABEL, ops: bank.delta }, null, 2)}\n`);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(bank.manifest, null, 2)}\n`);
}

/** The held-out set as an exam file (same shape as the main exam). */
export function writeHeldout(file: string, bank: SyntheticBank): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ label: `${SYNTHETIC_LABEL} Held-out set, frozen when committed.`, seed: bank.manifest.seed, cases: bank.heldout }, null, 2)}\n`,
  );
}

/** The second held-out set as an exam file (same shape as the first). */
export function writeHeldout2(file: string, bank: SyntheticBank): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ label: `${SYNTHETIC_LABEL} Second held-out set, written before any system output on it was seen and frozen when its hash is recorded.`, seed: bank.manifest.seed, cases: bank.heldout2 }, null, 2)}\n`,
  );
}

/** The third held-out set as an exam file (same shape as the first two). */
export function writeHeldout3(file: string, bank: SyntheticBank): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ label: `${SYNTHETIC_LABEL} Third held-out set, written before any system output on it was seen and frozen when its hash is recorded.`, seed: bank.manifest.seed, cases: bank.heldout3 }, null, 2)}\n`,
  );
}

/** The fourth held-out set as an exam file (same shape as the first three). */
export function writeHeldout4(file: string, bank: SyntheticBank): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ label: `${SYNTHETIC_LABEL} Fourth held-out set, written before any system output on it was seen and frozen when its hashes are recorded.`, seed: bank.manifest.seed, cases: bank.heldout4 }, null, 2)}\n`,
  );
}

export function writeExam(file: string, bank: SyntheticBank): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ label: SYNTHETIC_LABEL, seed: bank.manifest.seed, cases: bank.cases }, null, 2)}\n`,
  );
}

export { CURRENT_TIME };

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { customerProfileFromRows } from "../matching/adapters.js";
import { compareParty, type MatchThresholds } from "../matching/compare.js";
import { shortHash, type TableRows } from "../model.js";
import {
  type AlertRow,
  AlertRowSchema,
  type CustomerIdentifierRow,
  CustomerIdentifierRowSchema,
  type CustomerRow,
  CustomerRowSchema,
  SYNTHETIC_LABEL,
  type SyntheticTables,
} from "./model.js";
import { createRng } from "./random.js";
import { type Candidate, candidatesFrom, planScenarios, type Scenario, type ScenarioPlan } from "./scenarios.js";

/** The small labelled customer and alert set used to run a review end to end. */

export const SLICE_PLAN: readonly ScenarioPlan[] = [
  { kind: "true_match_exact", count: 2 },
  { kind: "true_match_variant", count: 1 },
  { kind: "false_positive_dob", count: 2 },
  { kind: "false_positive_surname", count: 1 },
  { kind: "false_positive_country", count: 1 },
  { kind: "missing_dob", count: 1 },
  { kind: "partial_dob_year", count: 1 },
  { kind: "identifier_match", count: 1 },
  { kind: "company_suffix_variant", count: 1 },
  { kind: "company_other_country", count: 1 },
  { kind: "non_latin_alias", count: 1 },
];

export interface CaseLabel {
  alert_id: string;
  customer_id: string;
  scenario: Scenario["kind"];
  /** The listed party the alert was raised against. */
  entry_id: string;
  /** The listed party the scenario was built from (differs only when another party scored higher). */
  source_entry_id: string;
  expected: Scenario["expected"];
  acceptable: Scenario["acceptable"];
  note: string;
}

export interface SliceBank {
  tables: SyntheticTables;
  cases: CaseLabel[];
  manifest: { label: string; seed: string; counts: Record<string, number> };
}

const DESKS = ["EMEA", "APAC", "AMER"] as const;
/** A plain screening engine alerts at a lower name score than the review policy treats as a strong name match. */
export const ALERT_THRESHOLD = 0.75;
const SPARE_SCENARIOS = 4;
const ALERT_TIME = "2026-10-22T09:00:00.000Z";

/** The best-matching listed party for a customer, by name only (what a plain screening engine does). */
export function raiseAlert(
  customer: CustomerRow,
  identifiers: readonly CustomerIdentifierRow[],
  candidates: readonly Candidate[],
  thresholds: MatchThresholds,
) {
  const profile = customerProfileFromRows(customer, identifiers);
  let best: { candidate: Candidate; score: number; name: string } | undefined;
  for (const candidate of candidates) {
    const r = compareParty(profile, candidate.party, thresholds);
    if (!best || r.name.score > best.score) best = { candidate, score: r.name.score, name: r.name.listed_name };
  }
  return best;
}

export function buildSliceBank(
  list: TableRows,
  seed: string,
  thresholds: MatchThresholds,
  plan: readonly ScenarioPlan[] = SLICE_PLAN,
): SliceBank {
  const rng = createRng(seed);
  const candidates = candidatesFrom(list);
  // Plan a few spare scenarios per kind: a scenario is only kept if the matcher really raises its alert.
  const spare = plan.map((p) => ({ ...p, count: p.count + SPARE_SCENARIOS }));
  const scenarios = planScenarios(candidates, spare, rng, seed);
  const wanted = new Map(plan.map((p) => [p.kind, p.count]));
  const made = new Map<string, number>();

  const customer: CustomerRow[] = [];
  const customer_identifier: CustomerIdentifierRow[] = [];
  const alert: AlertRow[] = [];
  const cases: CaseLabel[] = [];

  for (const s of scenarios) {
    if ((made.get(s.kind) ?? 0) >= (wanted.get(s.kind) ?? 0)) continue;
    const i = customer.length;
    const n = String(i + 1).padStart(3, "0");
    const row = CustomerRowSchema.parse({
      customer_id: `CUST-${n}`,
      customer_type: s.customer.customer_type,
      full_name: s.customer.full_name,
      date_of_birth: s.customer.date_of_birth,
      nationality: s.customer.nationality,
      residence_country: s.customer.residence_country,
      onboarding_date: `20${String(15 + (i % 9)).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
      risk_rating:
        s.customer.customer_type === "company" || s.kind === "identifier_match"
          ? "high"
          : rng.pick(["low", "medium"] as const),
      desk: DESKS[i % DESKS.length],
      data_origin: "synthetic",
    });
    const ids: CustomerIdentifierRow[] = [];
    if (s.customer.identifier) {
      ids.push(
        CustomerIdentifierRowSchema.parse({
          identifier_id: `IDN-${n}-1`,
          customer_id: row.customer_id,
          id_type: s.customer.identifier.id_type,
          id_number: s.customer.identifier.id_number,
          issuing_country: s.customer.identifier.issuing_country,
        }),
      );
    }

    const hit = raiseAlert(row, ids, candidates, thresholds);
    if (!hit || hit.score < ALERT_THRESHOLD) continue;
    customer.push(row);
    customer_identifier.push(...ids);
    made.set(s.kind, (made.get(s.kind) ?? 0) + 1);
    const alertRow = AlertRowSchema.parse({
      alert_id: `ALR-${n}`,
      alert_type: "customer",
      customer_id: row.customer_id,
      payment_id: null,
      list_id: hit.candidate.party.listId,
      entry_id: hit.candidate.party.entryId,
      matched_name: hit.name,
      match_score: hit.score.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""),
      raised_at: ALERT_TIME,
      status: "open",
    });
    alert.push(alertRow);
    cases.push({
      alert_id: alertRow.alert_id,
      customer_id: row.customer_id,
      scenario: s.kind,
      entry_id: alertRow.entry_id,
      source_entry_id: s.entry_id,
      expected: s.expected,
      acceptable: s.acceptable,
      note: s.note,
    });
  }

  const tables = { customer, customer_identifier, alert };
  return {
    tables,
    cases,
    manifest: {
      label: SYNTHETIC_LABEL,
      seed: `${seed}#${shortHash(seed, String(customer.length))}`,
      counts: {
        customer: customer.length,
        customer_identifier: customer_identifier.length,
        alert: alert.length,
        cases: cases.length,
      },
    },
  };
}

export function writeSliceBank(dir: string, bank: SliceBank): string {
  const out = resolveProjectPath(dir);
  mkdirSync(out, { recursive: true });
  for (const [name, rows] of Object.entries(bank.tables))
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify(rows)}\n`);
  writeFileSync(join(out, "cases.json"), `${JSON.stringify(bank.cases, null, 2)}\n`);
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(bank.manifest, null, 2)}\n`);
  return out;
}

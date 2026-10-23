import type { Decision } from "@sanctions-desk/shared";
import type { DeltaOp } from "../delta.js";
import { customerProfileFromRows } from "../matching/adapters.js";
import { compareParty } from "../matching/compare.js";
import { shortHash } from "../model.js";
import type {
  AccountRow,
  AlertRow,
  BeneficialOwnerRow,
  CustomerAliasRow,
  CustomerIdentifierRow,
  CustomerRow,
  DispositionRow,
  PaymentRow,
  SyntheticTables,
} from "./model.js";
import type { Rng } from "./random.js";
import type { Candidate } from "./scenarios.js";

/** The eleven groups of the review exam. */
export const EXAM_GROUPS = [
  "false_positive",
  "true_match",
  "transliteration",
  "missing_data",
  "hidden_ownership",
  "ownership_below",
  "previously_cleared_unchanged",
  "previously_cleared_changed",
  "injection",
  "tipping_off",
  "payment_jurisdiction",
] as const;
export type ExamGroup = (typeof EXAM_GROUPS)[number];

/** How many cases each group has. The total is 65. */
export const EXAM_GROUP_SIZES: Readonly<Record<ExamGroup, number>> = {
  false_positive: 15,
  true_match: 8,
  transliteration: 6,
  missing_data: 5,
  hidden_ownership: 6,
  ownership_below: 4,
  previously_cleared_unchanged: 6,
  previously_cleared_changed: 5,
  injection: 3,
  tipping_off: 2,
  payment_jurisdiction: 5,
};

export type ExpectedOutcome = Decision | "DRAFT_BLOCKED";

export interface ExamCase {
  case_id: string;
  group: ExamGroup;
  kind: string;
  title: string;
  alert_id: string | null;
  alert_type: "customer" | "payment" | null;
  customer_id: string | null;
  /** The listed party the alert is about. */
  entry_id: string | null;
  /** For a tipping-off case: the draft text that must be refused. */
  draft?: string;
  expected: ExpectedOutcome;
  /** Other outcomes that are acceptable. */
  acceptable: Decision[];
  /** Outcomes that would be wrong: the system must never give these. */
  must_not: Decision[];
  /** Edge cases from the review's edge-case list that this case exercises. */
  edge_cases: string[];
  note: string;
}

export interface CaseInput {
  kind: string;
  group: ExamGroup;
  title: string;
  alert_id: string | null;
  alert_type: ExamCase["alert_type"];
  customer_id: string | null;
  entry_id: string | null;
  draft?: string;
  expected: ExpectedOutcome;
  acceptable?: Decision[];
  must_not?: Decision[];
  edge_cases?: string[];
  note: string;
}

const DESKS = ["EMEA", "APAC", "AMER"] as const;
const THRESHOLD = { nameSimilarity: 0.85 };
export const CURRENT_TIME = "2026-10-22T09:00:00.000Z";

/** Everything a case builder needs: the rows built so far, the listed parties to start from, and id counters. */
export class BankBuilder {
  readonly tables: SyntheticTables;
  readonly cases: ExamCase[] = [];
  readonly delta: DeltaOp[] = [];
  readonly used = new Set<string>();
  private readonly counters = new Map<string, number>();

  constructor(
    readonly rng: Rng,
    readonly seed: string,
    readonly candidates: readonly Candidate[],
    tables: SyntheticTables,
    private readonly hashes: ReadonlyMap<string, { hash: string; snapshot: string }>,
  ) {
    this.tables = tables;
  }

  next(prefix: string, width = 4): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(width, "0")}`;
  }

  /** The first listed party that fits, in an order fixed by the seed and the kind. Each party is used once. */
  pick(kind: string, fits: (c: Candidate) => boolean): Candidate {
    const pool = this.candidates
      .filter((c) => !this.used.has(c.party.entryId) && fits(c))
      .sort((a, b) =>
        shortHash(this.seed, kind, a.party.entryId).localeCompare(shortHash(this.seed, kind, b.party.entryId)),
      );
    const found = pool[0];
    if (!found) throw new Error(`no listed party is left for the "${kind}" case`);
    this.used.add(found.party.entryId);
    return found;
  }

  entryHash(entryId: string): { hash: string; snapshot: string } {
    const found = this.hashes.get(entryId);
    if (!found) throw new Error(`unknown list entry ${entryId}`);
    return found;
  }

  customer(input: Partial<CustomerRow> & Pick<CustomerRow, "full_name" | "customer_type">): CustomerRow {
    const id = this.next("CUST");
    const index = this.tables.customer.length;
    const row: CustomerRow = {
      customer_id: id,
      date_of_birth: null,
      nationality: null,
      residence_country: "GB",
      onboarding_date: `20${String(14 + (index % 11)).padStart(2, "0")}-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
      risk_rating: input.customer_type === "company" ? "medium" : "low",
      desk: DESKS[index % DESKS.length] as CustomerRow["desk"],
      notes: null,
      data_origin: "synthetic",
      ...input,
    };
    this.tables.customer.push(row);
    this.account(row.customer_id);
    return row;
  }

  identifier(
    customerId: string,
    id_type: CustomerIdentifierRow["id_type"],
    id_number: string,
    issuing_country: string | null,
  ) {
    const row: CustomerIdentifierRow = {
      identifier_id: this.next("IDN"),
      customer_id: customerId,
      id_type,
      id_number,
      issuing_country,
    };
    this.tables.customer_identifier.push(row);
    return row;
  }

  alias(customerId: string, alias_name: string, alias_kind: CustomerAliasRow["alias_kind"]) {
    this.tables.customer_alias.push({ alias_id: this.next("CAL"), customer_id: customerId, alias_name, alias_kind });
  }

  account(customerId: string): AccountRow {
    const index = this.tables.account.length;
    const row: AccountRow = {
      account_id: this.next("ACC", 5),
      customer_id: customerId,
      account_type: (["current", "savings", "trade", "loan"] as const)[index % 4] as AccountRow["account_type"],
      currency: (["EUR", "GBP", "USD", "SGD", "CHF"] as const)[index % 5] as string,
      opened_on: `20${String(15 + (index % 10)).padStart(2, "0")}-0${(index % 9) + 1}-1${(index % 9) + 1}`,
      status: "active",
    };
    this.tables.account.push(row);
    return row;
  }

  payment(
    input: Partial<PaymentRow> & Pick<PaymentRow, "customer_id" | "counterparty_name" | "counterparty_country">,
  ): PaymentRow {
    const account = this.tables.account.find((a) => a.customer_id === input.customer_id);
    if (!account) throw new Error(`customer ${input.customer_id} has no account`);
    const row: PaymentRow = {
      payment_id: this.next("PAY", 5),
      account_id: account.account_id,
      direction: "outbound",
      amount: "12500.00",
      currency: account.currency,
      counterparty_bank_bic: null,
      beneficiary_bank_country: null,
      intermediary_bank_country: null,
      payment_reference: null,
      value_date: "2026-10-23",
      status: "pending",
      ...input,
    };
    this.tables.payment.push(row);
    return row;
  }

  owner(input: Omit<BeneficialOwnerRow, "ownership_id" | "as_of"> & { as_of?: string }): BeneficialOwnerRow {
    const row: BeneficialOwnerRow = { ownership_id: this.next("OWN", 5), as_of: "2026-09-30", ...input };
    this.tables.beneficial_owner.push(row);
    return row;
  }

  /** The alert a screening engine would raise: it names the best matching listed name and its score. */
  alert(input: {
    customer: CustomerRow;
    candidate: Candidate;
    source: AlertRow["alert_source"];
    paymentId?: string;
    matchedName?: string;
    score?: number;
    status?: AlertRow["status"];
    raisedAt?: string;
  }): AlertRow {
    const ids = this.tables.customer_identifier.filter((i) => i.customer_id === input.customer.customer_id);
    const comparison = compareParty(customerProfileFromRows(input.customer, ids), input.candidate.party, THRESHOLD);
    const score = input.score ?? comparison.name.score;
    const row: AlertRow = {
      alert_id: this.next("ALR"),
      alert_type: input.paymentId ? "payment" : "customer",
      alert_source: input.source,
      customer_id: input.customer.customer_id,
      payment_id: input.paymentId ?? null,
      list_id: input.candidate.party.listId as "OFAC" | "UN",
      entry_id: input.candidate.party.entryId,
      matched_name: input.matchedName ?? comparison.name.listed_name,
      match_score: String(Math.round(score * 1000) / 1000),
      raised_at: input.raisedAt ?? CURRENT_TIME,
      status: input.status ?? "open",
    };
    this.tables.alert.push(row);
    return row;
  }

  /** An earlier, closed alert and the analyst's recorded decision about it. */
  priorDisposition(
    customer: CustomerRow,
    candidate: Candidate,
    reasons: string,
    month: number,
    decision: DispositionRow["decision"] = "CLOSE_FALSE_POSITIVE",
  ): DispositionRow {
    const raisedAt = `2026-0${month}-12T10:00:00.000Z`;
    const earlier = this.alert({
      customer,
      candidate,
      source: "customer_name",
      status: decision === "CLOSE_FALSE_POSITIVE" ? "closed" : "escalated",
      raisedAt,
    });
    const { hash, snapshot } = this.entryHash(candidate.party.entryId);
    const row: DispositionRow = {
      disposition_id: this.next("DSP"),
      alert_id: earlier.alert_id,
      customer_id: customer.customer_id,
      entry_id: candidate.party.entryId,
      decision,
      reason_codes: reasons,
      decided_at: `2026-0${month}-12T14:30:00.000Z`,
      decided_by: `analyst.synthetic.${(month % 3) + 1}`,
      entry_content_hash: hash,
      list_snapshot_id: snapshot,
    };
    this.tables.disposition.push(row);
    return row;
  }

  addCase(input: CaseInput): ExamCase {
    const row: ExamCase = {
      case_id: `EX-${String(this.cases.length + 1).padStart(3, "0")}`,
      group: input.group,
      kind: input.kind,
      title: input.title,
      alert_id: input.alert_id,
      alert_type: input.alert_type,
      customer_id: input.customer_id,
      entry_id: input.entry_id,
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
      expected: input.expected,
      acceptable: input.acceptable ?? [],
      must_not: input.must_not ?? [],
      edge_cases: input.edge_cases ?? [],
      note: input.note,
    };
    this.cases.push(row);
    return row;
  }
}

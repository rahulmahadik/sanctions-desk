import { z } from "zod";

/**
 * Synthetic bank tables. Every value is a string (or null), exactly as the data layer returns them,
 * so the same rows can be written as JSON arrays, CSV or Postgres rows and keep one shape.
 * Every table carries `data_origin = "synthetic"` where it holds people or companies.
 */

const nonEmpty = z.string().min(1);
const iso2 = z.string().length(2);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const partialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/);
const origin = z.literal("synthetic");

export const CUSTOMER_TYPES = ["individual", "company"] as const;

export const CustomerRowSchema = z.strictObject({
  customer_id: nonEmpty,
  customer_type: z.enum(CUSTOMER_TYPES),
  full_name: nonEmpty,
  date_of_birth: partialDate.nullable(),
  nationality: iso2.nullable(),
  residence_country: iso2,
  onboarding_date: isoDate,
  risk_rating: z.enum(["low", "medium", "high"]),
  desk: z.enum(["EMEA", "APAC", "AMER"]),
  /** Free-text note from onboarding or review. Treated as data, never as instructions. */
  notes: z.string().max(500).nullable(),
  data_origin: origin,
});
export type CustomerRow = z.infer<typeof CustomerRowSchema>;

export const CustomerIdentifierRowSchema = z.strictObject({
  identifier_id: nonEmpty,
  customer_id: nonEmpty,
  id_type: z.enum(["passport", "national_id", "tax_id", "registration"]),
  id_number: nonEmpty,
  issuing_country: iso2.nullable(),
});
export type CustomerIdentifierRow = z.infer<typeof CustomerIdentifierRowSchema>;

export const AlertRowSchema = z.strictObject({
  alert_id: nonEmpty,
  alert_type: z.enum(["customer", "payment"]),
  /** What raised the alert: the customer's own name, a name on the ownership register, or a payment party. */
  alert_source: z.enum(["customer_name", "ownership", "payment"]),
  customer_id: nonEmpty,
  payment_id: nonEmpty.nullable(),
  list_id: z.enum(["OFAC", "UN"]),
  entry_id: nonEmpty,
  matched_name: nonEmpty,
  match_score: z.string().regex(/^(0|1)(\.\d{1,3})?$/),
  raised_at: z.iso.datetime(),
  status: z.enum(["open", "closed", "escalated"]),
});
export type AlertRow = z.infer<typeof AlertRowSchema>;

export const CustomerAliasRowSchema = z.strictObject({
  alias_id: nonEmpty,
  customer_id: nonEmpty,
  alias_name: nonEmpty,
  alias_kind: z.enum(["former", "trading", "spelling"]),
});
export type CustomerAliasRow = z.infer<typeof CustomerAliasRowSchema>;

export const AccountRowSchema = z.strictObject({
  account_id: nonEmpty,
  customer_id: nonEmpty,
  account_type: z.enum(["current", "savings", "trade", "loan"]),
  currency: z.string().length(3),
  opened_on: isoDate,
  status: z.enum(["active", "dormant", "closed"]),
});
export type AccountRow = z.infer<typeof AccountRowSchema>;

/** Who owns how much of a company. Owners may be customers, listed parties or outside parties. */
export const OWNER_PARTY_KINDS = ["customer", "listed", "external"] as const;
export const BeneficialOwnerRowSchema = z.strictObject({
  ownership_id: nonEmpty,
  owned_party_id: nonEmpty,
  owned_party_kind: z.enum(["customer", "external"]),
  owner_party_id: nonEmpty,
  owner_party_kind: z.enum(OWNER_PARTY_KINDS),
  owner_name: nonEmpty,
  /** Percent as a number string such as "50", "49.9" or "25.5". Empty when the register does not say. */
  ownership_pct: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/)
    .nullable(),
  as_of: isoDate,
});
export type BeneficialOwnerRow = z.infer<typeof BeneficialOwnerRowSchema>;

export const DispositionRowSchema = z.strictObject({
  disposition_id: nonEmpty,
  alert_id: nonEmpty,
  customer_id: nonEmpty,
  entry_id: nonEmpty,
  decision: z.enum(["CLOSE_FALSE_POSITIVE", "ESCALATE_L2", "RECOMMEND_BLOCK", "NEED_MORE_INFO"]),
  reason_codes: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}(,[A-Z][A-Z0-9_]{2,63})*$/),
  decided_at: z.iso.datetime(),
  decided_by: nonEmpty,
  /** Content hash of the listed entry when it was cleared. A different hash now means the entry changed. */
  entry_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  list_snapshot_id: nonEmpty,
});
export type DispositionRow = z.infer<typeof DispositionRowSchema>;

export const PaymentRowSchema = z.strictObject({
  payment_id: nonEmpty,
  customer_id: nonEmpty,
  account_id: nonEmpty,
  direction: z.enum(["outbound", "inbound"]),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
  currency: z.string().length(3),
  counterparty_name: nonEmpty,
  counterparty_country: iso2,
  counterparty_bank_bic: z.string().max(11).nullable(),
  /** Country of the beneficiary's bank, when the payment names one. */
  beneficiary_bank_country: iso2.nullable(),
  /** Country of an intermediary bank on the route, when the payment names one. */
  intermediary_bank_country: iso2.nullable(),
  /** Free-text payment reference. Treated as data, never as instructions. */
  payment_reference: z.string().max(500).nullable(),
  value_date: isoDate,
  status: z.enum(["pending", "released", "held"]),
});
export type PaymentRow = z.infer<typeof PaymentRowSchema>;

export const SYNTHETIC_TABLES = {
  customer: CustomerRowSchema,
  customer_identifier: CustomerIdentifierRowSchema,
  customer_alias: CustomerAliasRowSchema,
  account: AccountRowSchema,
  beneficial_owner: BeneficialOwnerRowSchema,
  alert: AlertRowSchema,
  disposition: DispositionRowSchema,
  payment: PaymentRowSchema,
} as const;
export type SyntheticTableName = keyof typeof SYNTHETIC_TABLES;
export const SYNTHETIC_TABLE_NAMES = Object.keys(SYNTHETIC_TABLES) as SyntheticTableName[];

export interface SyntheticTables {
  customer: CustomerRow[];
  customer_identifier: CustomerIdentifierRow[];
  customer_alias: CustomerAliasRow[];
  account: AccountRow[];
  beneficial_owner: BeneficialOwnerRow[];
  alert: AlertRow[];
  disposition: DispositionRow[];
  payment: PaymentRow[];
}

export const emptySyntheticTables = (): SyntheticTables => ({
  customer: [],
  customer_identifier: [],
  customer_alias: [],
  account: [],
  beneficial_owner: [],
  alert: [],
  disposition: [],
  payment: [],
});

export const SYNTHETIC_LABEL =
  "Synthetic data generated for development and demonstration. No real customer, account or payment.";

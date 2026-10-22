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

export const SYNTHETIC_TABLES = {
  customer: CustomerRowSchema,
  customer_identifier: CustomerIdentifierRowSchema,
  alert: AlertRowSchema,
} as const;
export type SyntheticTableName = keyof typeof SYNTHETIC_TABLES;
export const SYNTHETIC_TABLE_NAMES = Object.keys(SYNTHETIC_TABLES) as SyntheticTableName[];

export interface SyntheticTables {
  customer: CustomerRow[];
  customer_identifier: CustomerIdentifierRow[];
  alert: AlertRow[];
}

export const SYNTHETIC_LABEL =
  "Synthetic data generated for development and demonstration. No real customer, account or payment.";

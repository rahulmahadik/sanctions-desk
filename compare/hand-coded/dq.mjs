// Data quality: one function per rule, each returning the failing rows.
import { readFileSync } from "node:fs";

const ISO2 = new Set(JSON.parse(readFileSync(new URL("./iso2.json", import.meta.url), "utf8")));
const present = (v) => v !== null && v !== undefined && v !== "";

export const rules = {
  dob_present_for_individuals: (d) =>
    d.customer.filter((c) => c.customer_type === "individual" && !present(c.date_of_birth)),
  nationality_is_iso2: (d) => d.customer.filter((c) => present(c.nationality) && !ISO2.has(c.nationality)),
  ownership_pct_in_range: (d) =>
    d.beneficial_owner.filter(
      (o) => present(o.ownership_pct) && !(Number(o.ownership_pct) >= 0 && Number(o.ownership_pct) <= 100),
    ),
  ownership_pct_present: (d) => d.beneficial_owner.filter((o) => !present(o.ownership_pct)),
  payment_amount_positive: (d) => d.payment.filter((p) => !(Number(p.amount) > 0)),
  counterparty_country_valid: (d) => d.payment.filter((p) => !ISO2.has(p.counterparty_country)),
  payment_bank_countries_valid: (d) =>
    d.payment.filter(
      (p) =>
        (present(p.beneficiary_bank_country) && !ISO2.has(p.beneficiary_bank_country)) ||
        (present(p.intermediary_bank_country) && !ISO2.has(p.intermediary_bank_country)),
    ),
  match_score_in_range: (d) => d.alert.filter((a) => !(Number(a.match_score) >= 0 && Number(a.match_score) <= 1)),
};

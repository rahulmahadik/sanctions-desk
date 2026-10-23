// Data quality: a registry of rules with a run history.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

const ISO2 = new Set(JSON.parse(readFileSync(new URL("./iso2.json", import.meta.url), "utf8")));
const present = (v) => v !== null && v !== undefined && v !== "";

export const rules = {
  dob_present_for_individuals: {
    table: "customer",
    failing: (rows) => rows.filter((c) => c.customer_type === "individual" && !present(c.date_of_birth)),
  },
  nationality_is_iso2: {
    table: "customer",
    failing: (rows) => rows.filter((c) => present(c.nationality) && !ISO2.has(c.nationality)),
  },
  ownership_pct_in_range: {
    table: "beneficial_owner",
    failing: (rows) =>
      rows.filter((o) => present(o.ownership_pct) && !(Number(o.ownership_pct) >= 0 && Number(o.ownership_pct) <= 100)),
  },
  ownership_pct_present: {
    table: "beneficial_owner",
    failing: (rows) => rows.filter((o) => !present(o.ownership_pct)),
  },
  payment_amount_positive: { table: "payment", failing: (rows) => rows.filter((p) => !(Number(p.amount) > 0)) },
  counterparty_country_valid: {
    table: "payment",
    failing: (rows) => rows.filter((p) => !ISO2.has(p.counterparty_country)),
  },
  payment_bank_countries_valid: {
    table: "payment",
    failing: (rows) =>
      rows.filter(
        (p) =>
          (present(p.beneficiary_bank_country) && !ISO2.has(p.beneficiary_bank_country)) ||
          (present(p.intermediary_bank_country) && !ISO2.has(p.intermediary_bank_country)),
      ),
  },
  watchlist_country_valid: {
    table: "internal_watchlist",
    failing: (rows) => rows.filter((w) => !ISO2.has(w.country_iso2)),
  },
  match_score_in_range: {
    table: "alert",
    failing: (rows) => rows.filter((a) => !(Number(a.match_score) >= 0 && Number(a.match_score) <= 1)),
  },
};

export function runRules(data, historyDir) {
  mkdirSync(historyDir, { recursive: true });
  return Object.entries(rules).map(([name, rule]) => {
    const rows = data[rule.table];
    const invalid = rule.failing(rows).length;
    const result = { rule: name, table: rule.table, total: rows.length, valid: rows.length - invalid, invalid };
    appendFileSync(
      `${historyDir}/dq-history.jsonl`,
      `${JSON.stringify({ ts: new Date().toISOString(), ...result })}\n`,
    );
    return result;
  });
}

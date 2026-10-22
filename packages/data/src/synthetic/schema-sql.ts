import { SYNTHETIC_TABLES, type SyntheticTableName } from "./model.js";

/**
 * The Postgres schema of the synthetic bank, written from the same row definitions as the JSON and CSV
 * files, so the database can never drift from them. The only types that are not text are the numbers.
 */

/** Load order: a table comes after the tables it points at. */
export const BANKDB_TABLE_ORDER: readonly SyntheticTableName[] = [
  "customer",
  "customer_identifier",
  "customer_alias",
  "account",
  "payment",
  "beneficial_owner",
  "alert",
  "disposition",
];

const NUMERIC: Readonly<Record<string, string>> = {
  "payment.amount": "numeric(14,2)",
  "beneficial_owner.ownership_pct": "numeric(5,2)",
  "alert.match_score": "numeric(4,3)",
};

const REFERENCES: Readonly<Record<string, string>> = {
  "customer_identifier.customer_id": "customer(customer_id)",
  "customer_alias.customer_id": "customer(customer_id)",
  "account.customer_id": "customer(customer_id)",
  "payment.customer_id": "customer(customer_id)",
  "payment.account_id": "account(account_id)",
  "alert.customer_id": "customer(customer_id)",
  "alert.payment_id": "payment(payment_id)",
  "disposition.customer_id": "customer(customer_id)",
  "disposition.alert_id": "alert(alert_id)",
};

/** Columns that may be empty. Everything else is NOT NULL. */
function nullable(table: SyntheticTableName, column: string): boolean {
  const field = (SYNTHETIC_TABLES[table].shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>)[
    column
  ];
  return field?.safeParse(null).success === true;
}

export function renderBankdbSchema(): string {
  const parts = [
    "-- Schema of the synthetic bank database. Generated from the row definitions; do not edit by hand.\n",
    "-- Every row is synthetic. Run `npm run bankdb:schema` after changing a row definition.\n",
  ];
  for (const table of BANKDB_TABLE_ORDER) {
    const columns = Object.keys(SYNTHETIC_TABLES[table].shape);
    const lines = columns.map((column, index) => {
      const key = `${table}.${column}`;
      const type = NUMERIC[key] ?? "text";
      const bits = [`  ${column} ${type}`];
      if (index === 0) bits.push("PRIMARY KEY");
      else if (!nullable(table, column)) bits.push("NOT NULL");
      const reference = REFERENCES[key];
      if (reference) bits.push(`REFERENCES ${reference}`);
      return bits.join(" ");
    });
    parts.push(`\nCREATE TABLE ${table} (\n${lines.join(",\n")}\n);\n`);
  }
  return parts.join("");
}

export function renderBankdbLoad(seedDir = "/seed"): string {
  const lines = ["-- Loads the synthetic rows. Empty cells are SQL NULL.\n"];
  for (const table of BANKDB_TABLE_ORDER) {
    const columns = Object.keys(SYNTHETIC_TABLES[table].shape).join(", ");
    lines.push(`COPY ${table} (${columns}) FROM '${seedDir}/${table}.csv' WITH (FORMAT csv, HEADER true, NULL '');\n`);
  }
  return lines.join("");
}

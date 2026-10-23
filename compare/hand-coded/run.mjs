// The joins and checks, by hand. Prints the same numbers as zetaris/queries/usl and the data-quality rules.
import { readBank, readList, readPayments } from "./connectors.mjs";
import { rules } from "./dq.mjs";

const env = process.env;
const started = Date.now();
const [bank, payment] = await Promise.all([readBank(env), readPayments(env)]);
const listEntry = readList(env.LISTS_DIR, "list_entry");
const listCountry = readList(env.LISTS_DIR, "list_country");
const data = { ...bank, payment };

const customers = new Map(data.customer.map((c) => [c.customer_id, c]));
const entries = new Map(listEntry.map((e) => [e.entry_id, e]));
const alerts = [...data.alert].sort((a, b) => a.alert_id.localeCompare(b.alert_id));
console.log("join 1: alert + customer + list entry");
for (const a of alerts.slice(0, 3)) {
  console.log(
    " ",
    a.alert_id,
    a.customer_id,
    customers.get(a.customer_id)?.customer_type,
    entries.get(a.entry_id)?.primary_name,
    entries.get(a.entry_id)?.list_id,
  );
}

const alerted = new Set(data.alert.map((a) => a.customer_id));
const pendingForAlerted = payment.filter((p) => p.status === "pending" && alerted.has(p.customer_id));
const alertsByCustomer = new Map();
for (const a of data.alert) alertsByCustomer.set(a.customer_id, (alertsByCustomer.get(a.customer_id) ?? 0) + 1);
const rowsJoined = pendingForAlerted.reduce((n, p) => n + alertsByCustomer.get(p.customer_id), 0);
const value = pendingForAlerted.reduce((s, p) => s + Number(p.amount) * alertsByCustomer.get(p.customer_id), 0);
console.log("join 2: pending payments of alerted customers", {
  customers: new Set(pendingForAlerted.map((p) => p.customer_id)).size,
  payments: rowsJoined,
  value: Math.round(value * 100) / 100,
});

const byCountry = new Map();
for (const a of data.alert) {
  // an inner join keeps one row per matching list_country row, so repeated country rows count repeatedly
  for (const c of listCountry.filter((c) => c.entry_id === a.entry_id)) {
    const hits = payment.filter(
      (p) => p.customer_id === a.customer_id && p.counterparty_country === c.country_iso2,
    ).length;
    if (hits > 0) byCountry.set(c.country_iso2, (byCountry.get(c.country_iso2) ?? 0) + hits);
  }
}
console.log("join 3: three sources", [...byCountry.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3));

for (const [name, rule] of Object.entries(rules)) console.log("DQ", name, "invalid =", rule(data).length);
console.log(`elapsed ${Date.now() - started} ms`);

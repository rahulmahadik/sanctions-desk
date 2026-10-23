// The three joins.
export function alertCustomerEntry(d, entries) {
  const customers = new Map(d.customer.map((c) => [c.customer_id, c]));
  const byEntry = new Map(entries.map((e) => [e.entry_id, e]));
  return [...d.alert]
    .sort((a, b) => a.alert_id.localeCompare(b.alert_id))
    .slice(0, 3)
    .map((a) => [
      a.alert_id,
      a.customer_id,
      customers.get(a.customer_id)?.customer_type,
      byEntry.get(a.entry_id)?.primary_name,
      byEntry.get(a.entry_id)?.list_id,
    ]);
}

export function pendingForAlerted(d) {
  const perCustomer = new Map();
  for (const a of d.alert) perCustomer.set(a.customer_id, (perCustomer.get(a.customer_id) ?? 0) + 1);
  const pending = d.payment.filter((p) => p.status === "pending" && perCustomer.has(p.customer_id));
  const payments = pending.reduce((n, p) => n + perCustomer.get(p.customer_id), 0);
  const value = pending.reduce((s, p) => s + Number(p.amount) * perCustomer.get(p.customer_id), 0);
  return { customers: new Set(pending.map((p) => p.customer_id)).size, payments, value: Math.round(value * 100) / 100 };
}

export function threeSources(d, listCountry) {
  const byCountry = new Map();
  for (const a of d.alert) {
    // an inner join keeps one row per matching list_country row, so repeated country rows count repeatedly
    for (const c of listCountry.filter((c) => c.entry_id === a.entry_id)) {
      const hits = d.payment.filter(
        (p) => p.customer_id === a.customer_id && p.counterparty_country === c.country_iso2,
      ).length;
      if (hits > 0) byCountry.set(c.country_iso2, (byCountry.get(c.country_iso2) ?? 0) + hits);
    }
  }
  return [...byCountry.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
}

export function watchlistByCountry(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.country_iso2, (counts.get(r.country_iso2) ?? 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3);
}

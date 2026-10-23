// Access control: each identity has tables it may read and columns it may not see.
const ALL = [
  "business_definition",
  "list_entry",
  "list_alias",
  "list_dob",
  "list_country",
  "list_identifier",
  "customer",
  "customer_identifier",
  "customer_alias",
  "account",
  "beneficial_owner",
  "payment",
  "alert",
  "disposition",
  "internal_watchlist",
];
export const ROLES = {
  evidence: { tables: ALL, hidden: { customer_identifier: ["id_number"], list_identifier: [] } },
  reviewer: { tables: ALL, hidden: {} },
  eval: { tables: ALL, hidden: {} },
};

export function createAccess(audit) {
  return {
    read(identity, table, rows) {
      const role = ROLES[identity];
      if (!role) throw new Error(`unknown identity ${identity}`);
      if (!role.tables.includes(table)) {
        audit.record({ identity, table, outcome: "refused" });
        throw new Error(`${identity} may not read ${table}`);
      }
      const hidden = new Set(role.hidden[table] ?? []);
      const visible = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k))));
      audit.record({ identity, table, rows: visible.length, hidden: [...hidden], outcome: "ok" });
      return visible;
    },
  };
}

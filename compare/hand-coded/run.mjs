// Glue: loads the sources, applies access, runs the joins and the rules, prints the same numbers as the Zetaris path.
import { createAccess } from "./access.mjs";
import { createAudit } from "./audit.mjs";
import { cached } from "./cache.mjs";
import { readBank, readList, readPayments } from "./connectors.mjs";
import { createDefinitions } from "./definitions.mjs";
import { runRules } from "./dq.mjs";
import { alertCustomerEntry, pendingForAlerted, threeSources, watchlistByCountry } from "./joins.mjs";

const env = process.env;
const out = env.OUT_DIR ?? "/out";
const started = Date.now();
const audit = createAudit(out);
const access = createAccess(audit);
const identity = "evidence";

const bankRaw = await readBank(env, ["customer", "customer_identifier", "alert", "beneficial_owner"]);
const payments = await cached(`${out}/cache`, "payments", 60_000, () => readPayments(env));
const lists = {
  internal_watchlist: readList(env.EXTRA_DIR, "internal_watchlist"),
  list_entry: readList(env.LISTS_DIR, "list_entry"),
  list_country: readList(env.LISTS_DIR, "list_country"),
  business_definition: readList(env.LISTS_DIR, "business_definition"),
};
const data = {};
for (const [table, rows] of Object.entries({ ...bankRaw, payment: payments.rows, ...lists }))
  data[table] = access.read(identity, table, rows);
console.log(`payments cache: ${payments.cache}`);

const defs = createDefinitions(data.business_definition, new URL("./descriptions.json", import.meta.url));
console.log(
  "definition false_positive@2:",
  defs.definition("false_positive", 2) ? "found" : "missing",
  "| tables described:",
  defs.tables().length,
);

console.log("join 1:", alertCustomerEntry(data, data.list_entry));
console.log("join 2:", pendingForAlerted(data));
console.log("join 3:", threeSources(data, data.list_country));
console.log("watchlist by country:", watchlistByCountry(data.internal_watchlist));
for (const r of runRules(data, out)) console.log("DQ", r.rule, "invalid =", r.invalid);

console.log(
  "id_number visible to evidence:",
  "id_number" in data.customer_identifier[0],
  "| to reviewer:",
  "id_number" in access.read("reviewer", "customer_identifier", bankRaw.customer_identifier)[0],
);
console.log(`elapsed ${Date.now() - started} ms`);

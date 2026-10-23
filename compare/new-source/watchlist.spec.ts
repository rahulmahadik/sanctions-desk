// What a person adds to packages/zetaris/src/usl-spec.ts to bring the internal watchlist into the model.
import type { UslTableSpec } from "@sanctions-desk/zetaris";

export const WATCHLIST_TABLE: UslTableSpec = {
  name: "internal_watchlist",
  description: "Parties on the bank's own internal watchlist, with the reason they were added.",
  source: "lists",
  notNull: ["watch_id", "party_name", "country_iso2"],
  columns: [
    { name: "watch_id", type: "varchar(64)", description: "Stable key of the watchlist row." },
    { name: "party_name", type: "varchar(500)", description: "Name of the watched party." },
    { name: "country_iso2", type: "varchar(2)", description: "Country of the party (ISO 3166-1 alpha-2)." },
    { name: "reason", type: "varchar(200)", description: "Why the party is on the list." },
    { name: "added_on", type: "varchar(10)", description: "Date added (YYYY-MM-DD)." },
  ],
};

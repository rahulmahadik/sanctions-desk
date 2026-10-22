import { USL_ROLES, USL_TABLE_ORDER, USL_TABLES, type UslColumnSpec, type UslTableSpec } from "./usl-spec.js";

/**
 * Renders the Zetaris setup scripts from the model spec. Each script is a list of statements that start at
 * a "-- @@ name" line, run one call at a time, and can be run again.
 */

const NAMESPACE = "lightning.metastore.sanctions";
const USL = "screening_usl";
const Q = `${NAMESPACE}.${USL}`;

export interface RenderOptions {
  /** ISO 3166-1 alpha-2 codes accepted by the country data-quality rules. */
  isoCodes: readonly string[];
}

const byName = new Map(USL_TABLES.map((t) => [t.name, t]));
const ordered = (): UslTableSpec[] =>
  USL_TABLE_ORDER.map((n) => {
    const t = byName.get(n);
    if (!t) throw new Error(`table ${n} is in the order but not in the spec`);
    return t;
  });

const block = (name: string, sql: string): string => `-- @@ ${name}\n${sql.trim()}\n`;
const join = (header: string, blocks: string[]): string => `${header.trim()}\n\n${blocks.join("\n")}`;

// ---- sources ------------------------------------------------------------------------------------

const LIST_FILE_TABLES = USL_TABLES.filter((t) => t.source === "lists");
const BANK_FILE_TABLES = USL_TABLES.filter((t) => t.source === "bank" || t.source === "payments");

function filestore(database: string, folder: string, table: string): string {
  return `CREATE LIGHTNING FILESTORE TABLE ${table} FROM ${database} FORMAT JSON OPTIONS (path "dffs://sanctions/${folder}/${table}.json")`;
}

function listsScript(): string {
  return join(
    `-- Public list tables and the approved business definitions, read from the Zetaris file store.
-- Files are written there by \`npm run zetaris:load-files\` (folder: sanctions) before this script runs.`,
    [
      block(
        "db_lists",
        `CREATE LIGHTNING DATABASE sanctions_lists DESCRIBE BY "Public sanctions list tables, sample subset"`,
      ),
      ...LIST_FILE_TABLES.map((t) => block(`file_${t.name}`, filestore("sanctions_lists", "sanctions_lists", t.name))),
    ],
  );
}

function bankFilesScript(): string {
  return join(
    `-- Fallback copy of the synthetic bank as files in the Zetaris file store. Use it with 06_activate_files_create.sql
-- when the bank database or the payments service cannot be reached.`,
    [
      block("db_bank_files", `CREATE LIGHTNING DATABASE sanctions_bank_files DESCRIBE BY "Synthetic bank, file copy"`),
      ...BANK_FILE_TABLES.map((t) =>
        block(`file_${t.name}`, filestore("sanctions_bank_files", "sanctions_bank_files", t.name)),
      ),
    ],
  );
}

const BANKDB = `-- The synthetic bank database, read through a read-only login over the Zetaris network.
-- The password is filled from BANKDB_READER_PASSWORD when the script runs; it is not stored here.`;
function bankdbScript(): string {
  return join(BANKDB, [
    block(
      "datasource_bankdb",
      `CREATE DATASOURCE sanctions_bankdb DESCRIBE BY "Synthetic bank database, read only" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://bankdb:5432/bank",
  username "zetaris_reader",
  password "\${BANKDB_READER_PASSWORD}",
  fetchsize "1000"
)`,
    ),
    block("register_bankdb_tables", "REGISTER DATASOURCE TABLES FROM sanctions_bankdb"),
  ]);
}

function paymentsScript(): string {
  return join(
    `-- The payments service, read as a REST table over the Zetaris network.
-- The key is filled from PAYMENTS_API_KEY when the script runs; it is not stored here.
-- A REST table calls the service for every query, so the result is cached after it is created.`,
    [
      block("db_payments", `CREATE LIGHTNING DATABASE sanctions_payments DESCRIBE BY "Payments service, read only"`),
      block(
        "rest_payments",
        `CREATE LIGHTNING REST TABLE payments_raw FROM sanctions_payments REQUEST (
  endpoint "http://payments-api:8100/payments",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER (x-api-key "\${PAYMENTS_API_KEY}") BODY ()`,
      ),
      block("cache_payments", "CACHE TABLE sanctions_payments.payments_raw"),
    ],
  );
}

// ---- the model ----------------------------------------------------------------------------------

function ddl(table: UslTableSpec): string {
  const refs = table.references ?? {};
  const notNull = new Set(table.notNull ?? []);
  const lines = table.columns.map((c, index) => {
    const parts = [`    ${c.name} ${c.type}`];
    if (notNull.has(c.name) || index === 0) parts.push("NOT NULL");
    if (index === 0) parts.push("PRIMARY KEY");
    const ref = refs[c.name];
    if (ref) parts.push(`FOREIGN KEY REFERENCES ${ref.replace(".", "(")})`);
    return parts.join(" ");
  });
  return `CREATE TABLE ${table.name} (\n${lines.join(",\n")}\n)`;
}

function descriptionOf(c: UslColumnSpec): string {
  return c.description.replace(/'/g, "");
}

function modelScript(): string {
  const tables = ordered();
  const blocks = [
    block("ns_metastore", "CREATE NAMESPACE IF NOT EXISTS lightning.metastore"),
    block("ns_sanctions", `CREATE NAMESPACE IF NOT EXISTS ${NAMESPACE}`),
    block(
      "compile_model",
      `COMPILE USL IF NOT EXISTS ${USL} DEPLOY NAMESPACE ${NAMESPACE} DDL\n${tables.map(ddl).join(";\n")}`,
    ),
    block(
      "describe_model",
      `UPDATE USL ${Q} SET DESCRIPTION Screening model: public sanctions lists, bank customers, ownership, payments, alerts and earlier decisions, with the approved business definitions. Synthetic bank data only.`,
    ),
  ];
  for (const t of tables) {
    blocks.push(
      block(`describe_${t.name}`, `UPDATE USL ${Q}.${t.name} SET TABLE DESCRIPTION ${t.description.replace(/'/g, "")}`),
    );
    for (const c of t.columns) {
      blocks.push(
        block(
          `describe_${t.name}_${c.name}`,
          `UPDATE USL ${Q}.${t.name}.${c.name} SET COLUMN DESCRIPTION ${descriptionOf(c)}`,
        ),
      );
    }
  }
  return join(
    `-- Semantic layer for the sanctions desk: namespace ${NAMESPACE}, model ${USL}.
-- Agents read only these tables. Foreign keys generate data-quality rules; more rules are in 07_dq_create.sql.
-- The multi-table COMPILE statement is one call.`,
    blocks,
  );
}

// ---- activation ---------------------------------------------------------------------------------

type Variant = "primary" | "files";

function sourceOf(table: UslTableSpec, variant: Variant): string {
  if (table.source === "lists") return `sanctions_lists.${table.name}`;
  if (variant === "files") return `sanctions_bank_files.${table.name}`;
  return table.source === "payments" ? "sanctions_payments.payments_raw" : `sanctions_bankdb.${table.name}`;
}

function selectOf(c: UslColumnSpec, notNull: boolean): string {
  const base = c.cast ?? c.name;
  if (c.cast) return notNull ? `COALESCE(${c.cast}, 0) AS ${c.name}` : `${c.cast} AS ${c.name}`;
  return notNull ? `COALESCE(${base}, '') AS ${c.name}` : c.name;
}

function activate(table: UslTableSpec, variant: Variant): string {
  const notNull = new Set(table.notNull ?? []);
  const fields = table.columns.map((c, i) => selectOf(c, notNull.has(c.name) || i === 0));
  return `ACTIVATE USL TABLE ${Q}.${table.name} AS\nSELECT\n    ${fields.join(",\n    ")}\nFROM ${sourceOf(table, variant)}`;
}

function activateScript(variant: Variant): string {
  const header =
    variant === "primary"
      ? "-- Binds each model table to its source: list files, the bank database over JDBC, and the cached payments service."
      : "-- Fallback: binds the bank tables to the file copy instead of the database and the payments service.";
  return join(
    header,
    ordered().map((t) => block(`activate_${t.name}`, activate(t, variant))),
  );
}

// ---- data quality and access --------------------------------------------------------------------

function dqRules(opts: RenderOptions): Array<{ name: string; table: string; expr: string }> {
  const list = opts.isoCodes.map((c) => `'${c}'`).join(", ");
  return [
    {
      name: "dob_present_for_individuals",
      table: "customer",
      expr: "customer_type <> 'individual' OR (date_of_birth IS NOT NULL AND date_of_birth <> '')",
    },
    { name: "nationality_is_iso2", table: "customer", expr: `nationality IS NULL OR nationality IN (${list})` },
    {
      name: "ownership_pct_in_range",
      table: "beneficial_owner",
      expr: "ownership_pct IS NULL OR (ownership_pct >= 0 AND ownership_pct <= 100)",
    },
    { name: "ownership_pct_present", table: "beneficial_owner", expr: "ownership_pct IS NOT NULL" },
    { name: "payment_amount_positive", table: "payment", expr: "amount > 0" },
    { name: "counterparty_country_valid", table: "payment", expr: `counterparty_country IN (${list})` },
    { name: "match_score_in_range", table: "alert", expr: "match_score >= 0 AND match_score <= 1" },
  ];
}

export const DQ_RULE_NAMES = (opts: RenderOptions): string[] => dqRules(opts).map((r) => r.name);

function dqScript(opts: RenderOptions): string {
  return join(
    "-- Data-quality rules, registered after the tables are active. Foreign keys already generate their own rules.",
    dqRules(opts).map((r) => block(`dq_${r.name}`, `REGISTER DQ ${r.name} TABLE ${Q}.${r.table} AS\n${r.expr}`)),
  );
}

function accessScript(): string {
  const blocks = USL_ROLES.map((r) =>
    block(`create_${r.name}`, `CREATE ROLE '${r.name}' DESCRIBE BY '${r.description}'`),
  );
  for (const role of USL_ROLES) {
    for (const t of ordered()) {
      blocks.push(
        block(`grant_${role.name}_${t.name}`, `GRANT SELECT ON USL TABLE ${Q}.${t.name} TO ROLE '${role.name}'`),
      );
    }
  }
  return join(
    `-- Roles and table-level grants for the three runtime identities. Users are created in the Zetaris UI and
-- assigned to these roles afterwards; the admin key is never used at runtime.`,
    blocks,
  );
}

// ---- checks -------------------------------------------------------------------------------------

function selectScript(title: string, blocks: string[]): string {
  return join(`-- ${title}`, blocks);
}

function resetScript(): string {
  return join(
    `-- Removes only the objects created by these scripts, so the setup can be rebuilt from scratch: the screening
-- model, the sanctions_* databases and the bank database registration. Nothing else is touched.`,
    [
      // The cached payments table outlives the database it was created in, so it is released first.
      block("uncache_payments", "UNCACHE TABLE sanctions_payments.payments_raw"),
      block("remove_model", `REMOVE USL ${USL} NAMESPACE ${NAMESPACE}`),
      block("drop_lists", "DROP LIGHTNING DATABASE sanctions_lists"),
      block("drop_bank_files", "DROP LIGHTNING DATABASE sanctions_bank_files"),
      block("drop_payments", "DROP LIGHTNING DATABASE sanctions_payments"),
      block("drop_bankdb", "DROP DATASOURCE sanctions_bankdb"),
    ],
  );
}

export function renderScripts(opts: RenderOptions): Record<string, string> {
  const count = (name: string, from: string) => block(`count_${name}`, `SELECT COUNT(*) AS n FROM ${from}`);
  return {
    "00_reset_create.sql": resetScript(),
    "01_lists_create.sql": listsScript(),
    "01_lists_select.sql": selectScript(
      "Row counts of the list tables in the file store.",
      LIST_FILE_TABLES.map((t) => count(t.name, `sanctions_lists.${t.name}`)),
    ),
    "02_bank_files_create.sql": bankFilesScript(),
    "03_bankdb_create.sql": bankdbScript(),
    "03_bankdb_select.sql": selectScript(
      "Row counts read from the bank database.",
      USL_TABLES.filter((t) => t.source === "bank").map((t) => count(t.name, `sanctions_bankdb.${t.name}`)),
    ),
    "04_payments_create.sql": paymentsScript(),
    "04_payments_select.sql": selectScript("Rows read from the payments service.", [
      count("payments", "sanctions_payments.payments_raw"),
    ]),
    "05_usl_create.sql": modelScript(),
    "05_usl_select.sql": selectScript("The model as Zetaris describes it.", [
      block("list_model", `SHOW NAMESPACES OR TABLES IN ${NAMESPACE}`),
      block("load_model", `LOAD USL ${USL} NAMESPACE ${NAMESPACE}`),
      block("list_dq", `LIST DQ USL ${Q}`),
    ]),
    "06_activate_create.sql": activateScript("primary"),
    "06_activate_files_create.sql": activateScript("files"),
    "06_activate_select.sql": selectScript(
      "Row counts through the semantic layer.",
      ordered().map((t) => count(t.name, `${Q}.${t.name}`)),
    ),
    "07_dq_create.sql": dqScript(opts),
    "07_dq_select.sql": selectScript("What the data-quality rules find.", [
      ...dqRules(opts).map((r) => block(`run_${r.name}`, `RUN DQ ${r.name} TABLE ${Q}.${r.table}`)),
      block("invalid_customers", `SHOW DQ ALL INVALID TABLE ${Q}.customer`),
    ]),
    "08_access_create.sql": accessScript(),
    "08_access_select.sql": selectScript("Roles and what they may read.", [
      block("roles", "SHOW ROLES"),
      ...USL_ROLES.map((r) => block(`grants_${r.name}`, `SHOW GRANT ROLE '${r.name}' ON ALL`)),
    ]),
  };
}

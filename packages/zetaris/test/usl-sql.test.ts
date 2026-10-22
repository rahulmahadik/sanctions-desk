import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BusinessDefinitionSchema, ISO_COUNTRIES, SYNTHETIC_TABLES, TABLES } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { parseStatements } from "../src/setup.js";
import { USL_ROLES, USL_TABLE_ORDER, USL_TABLES } from "../src/usl-spec.js";
import { DQ_RULE_NAMES, renderScripts } from "../src/usl-sql.js";

/** A placeholder as written in a script: dollar sign, brace, NAME, brace. */
const ph = (name: string): string => `$\u007b${name}}`;

const options = { isoCodes: ISO_COUNTRIES.map(([iso2]) => iso2) };
const scripts = renderScripts(options);
const dir = resolveProjectPath("zetaris/sql");

describe("the semantic layer maps one to one onto the data", () => {
  const dataColumns = (name: string): string[] | undefined => {
    if (name === "business_definition") return Object.keys(BusinessDefinitionSchema.shape);
    if (name in SYNTHETIC_TABLES) return Object.keys(SYNTHETIC_TABLES[name as keyof typeof SYNTHETIC_TABLES].shape);
    if (name in TABLES) return Object.keys(TABLES[name as keyof typeof TABLES].shape);
    return undefined;
  };

  it("has a table for every data table the agents read, with the same columns in the same order", () => {
    const wanted = USL_TABLE_ORDER;
    expect(USL_TABLES.map((t) => t.name).sort()).toEqual([...wanted].sort());
    for (const table of USL_TABLES) {
      const expected = dataColumns(table.name);
      expect(expected, `${table.name} has no data definition`).toBeDefined();
      // The model column set is the data column set; list tables do not model the columns the agents never read.
      expect(
        table.columns.map((c) => c.name),
        table.name,
      ).toEqual(expected);
    }
  });

  it("lists every data table the bank has", () => {
    for (const name of Object.keys(SYNTHETIC_TABLES)) expect(USL_TABLE_ORDER, name).toContain(name);
  });

  it("makes the first column the key and points every reference at a real column", () => {
    const byName = new Map(USL_TABLES.map((t) => [t.name, t]));
    for (const table of USL_TABLES) {
      for (const [column, target] of Object.entries(table.references ?? {})) {
        expect(
          table.columns.some((c) => c.name === column),
          `${table.name}.${column}`,
        ).toBe(true);
        const [targetTable, targetColumn] = target.split(".");
        expect(
          byName.get(targetTable ?? "")?.columns.some((c) => c.name === targetColumn),
          target,
        ).toBe(true);
        expect(USL_TABLE_ORDER.indexOf(targetTable ?? ""), `${table.name} comes after ${targetTable}`).toBeLessThan(
          USL_TABLE_ORDER.indexOf(table.name),
        );
      }
    }
  });

  it("describes every table and column, and marks only customer identifiers as sensitive", () => {
    for (const table of USL_TABLES) {
      expect(table.description.length, table.name).toBeGreaterThan(20);
      for (const c of table.columns) expect(c.description.length, `${table.name}.${c.name}`).toBeGreaterThan(5);
    }
    const sensitive = USL_TABLES.flatMap((t) => t.columns.filter((c) => c.sensitive).map((c) => `${t.name}.${c.name}`));
    expect(sensitive).toEqual(["customer_identifier.id_number"]);
    const column = USL_TABLES.find((t) => t.name === "customer_identifier")?.columns.find(
      (c) => c.name === "id_number",
    );
    expect(column?.description).toContain("(sensitive)");
  });
});

describe("the committed scripts", () => {
  it("are exactly what the spec renders, so they cannot drift", () => {
    expect(
      readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort(),
    ).toEqual(Object.keys(scripts).sort());
    for (const [name, text] of Object.entries(scripts)) expect(readFileSync(join(dir, name), "utf8"), name).toBe(text);
  });

  it("parse into uniquely named statements and never contain a password or key", () => {
    for (const [name, text] of Object.entries(scripts)) {
      const statements = parseStatements(text);
      expect(statements.length, name).toBeGreaterThan(0);
      expect(text, name).not.toMatch(/password\s+"(?!\$\{)/i);
      expect(text, name).not.toMatch(/x-api-key\s+"(?!\$\{)/i);
    }
  });

  it("take credentials only as placeholders filled when run", () => {
    expect(scripts["03_bankdb_create.sql"]).toContain(`password "${ph("BANKDB_READER_PASSWORD")}"`);
    expect(scripts["04_payments_create.sql"]).toContain(`x-api-key "${ph("PAYMENTS_API_KEY")}"`);
  });

  it("create every table in one compile call and activate each of them from its source", () => {
    const compile = parseStatements(scripts["05_usl_create.sql"] ?? "").find((s) => s.name === "compile_model");
    for (const name of USL_TABLE_ORDER) expect(compile?.sql, name).toContain(`CREATE TABLE ${name} (`);
    const primary = parseStatements(scripts["06_activate_create.sql"] ?? "");
    const files = parseStatements(scripts["06_activate_files_create.sql"] ?? "");
    expect(primary.map((s) => s.name)).toEqual(USL_TABLE_ORDER.map((n) => `activate_${n}`));
    expect(primary.find((s) => s.name === "activate_customer")?.sql).toContain("FROM sanctions_bankdb.customer");
    expect(primary.find((s) => s.name === "activate_payment")?.sql).toContain("FROM sanctions_payments.payments_raw");
    expect(primary.find((s) => s.name === "activate_list_entry")?.sql).toContain("FROM sanctions_lists.list_entry");
    expect(files.find((s) => s.name === "activate_customer")?.sql).toContain("FROM sanctions_bank_files.customer");
    expect(files.find((s) => s.name === "activate_payment")?.sql).toContain("FROM sanctions_bank_files.payment");
  });

  it("casts the typed columns and keeps a missing percentage empty", () => {
    const owner = parseStatements(scripts["06_activate_create.sql"] ?? "").find(
      (s) => s.name === "activate_beneficial_owner",
    );
    expect(owner?.sql).toContain("CAST(ownership_pct AS DECIMAL(5,2)) AS ownership_pct");
    expect(owner?.sql).not.toContain("COALESCE(CAST(ownership_pct");
    const payment = parseStatements(scripts["06_activate_create.sql"] ?? "").find((s) => s.name === "activate_payment");
    expect(payment?.sql).toContain("COALESCE(CAST(amount AS DECIMAL(14,2)), 0) AS amount");
  });

  it("register the data-quality rules the product relies on", () => {
    expect(DQ_RULE_NAMES(options)).toEqual([
      "dob_present_for_individuals",
      "nationality_is_iso2",
      "ownership_pct_in_range",
      "ownership_pct_present",
      "payment_amount_positive",
      "counterparty_country_valid",
      "match_score_in_range",
    ]);
    const dq = parseStatements(scripts["07_dq_create.sql"] ?? "");
    expect(dq.find((s) => s.name === "dq_nationality_is_iso2")?.sql).toContain("'GB'");
  });

  it("grant the three runtime roles read access to every table and nothing else", () => {
    const access = parseStatements(scripts["08_access_create.sql"] ?? "");
    expect(access.filter((s) => s.sql.startsWith("CREATE ROLE")).map((s) => s.name)).toEqual(
      USL_ROLES.map((r) => `create_${r.name}`),
    );
    const grants = access.filter((s) => s.sql.startsWith("GRANT"));
    expect(grants).toHaveLength(USL_ROLES.length * USL_TABLE_ORDER.length);
    expect(grants.every((g) => /^GRANT SELECT ON USL TABLE /.test(g.sql))).toBe(true);
    expect(access.some((s) => /INSERT|UPDATE|DELETE|ALL/.test(s.sql.replace("ON ALL", "")))).toBe(false);
  });

  it("reset removes only what the scripts create", () => {
    const reset = parseStatements(scripts["00_reset_create.sql"] ?? "").map((s) => s.sql);
    expect(reset).toEqual([
      "UNCACHE TABLE sanctions_payments.payments_raw",
      "REMOVE USL screening_usl NAMESPACE lightning.metastore.sanctions",
      "DROP LIGHTNING DATABASE sanctions_lists",
      "DROP LIGHTNING DATABASE sanctions_bank_files",
      "DROP LIGHTNING DATABASE sanctions_payments",
      "DROP DATASOURCE sanctions_bankdb",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { blankLiterals, guardSql } from "../src/guard.js";

const NS = "lightning.metastore.sanctions";
const USL = "screening_usl";
const T = (name: string) => `${NS}.${USL}.${name}`;
const options = { namespace: NS, usl: USL, allowedTables: [T("customer"), T("alert"), T("list_entry")] };
const check = (sql: string) => guardSql(sql, options);
const reason = (sql: string) => {
  const v = check(sql);
  return v.ok ? "ok" : v.code;
};

describe("guardSql: what is allowed", () => {
  it("accepts a plain select on an allowed table", () => {
    const v = check(`SELECT customer_id, full_name FROM ${T("customer")} WHERE customer_id = 'CUST-001'`);
    expect(v).toMatchObject({ ok: true, kind: "select", tables: [T("customer")] });
  });
  it("accepts joins, quoted names, any case and values with quotes", () => {
    expect(
      check(
        `select a.alert_id from ${T("alert")} a JOIN \`${NS}\`.\`${USL}\`.\`CUSTOMER\` c ON a.customer_id = c.customer_id WHERE c.full_name = 'Smith'`,
      ).ok,
    ).toBe(true);
    expect(check(`SELECT * FROM ${T("customer").toUpperCase()} WHERE full_name = 'O''Brien'`).ok).toBe(true);
    expect(
      check(`SELECT COUNT(*) FROM ${T("alert")} a JOIN ${T("customer")} c ON a.customer_id = c.customer_id`).ok,
    ).toBe(true);
  });
  it("accepts a subquery that reads an allowed table", () => {
    expect(check(`SELECT * FROM (SELECT customer_id FROM ${T("customer")}) t`).ok).toBe(true);
  });
  it("accepts a constant select with no table", () => {
    expect(check("SELECT 1")).toMatchObject({ ok: true, tables: [] });
  });
  it("accepts the metadata statements for this model only", () => {
    expect(check(`SHOW NAMESPACES OR TABLES IN ${NS}`)).toMatchObject({ ok: true, kind: "show" });
    expect(check(`LOAD USL ${USL} NAMESPACE ${NS}`)).toMatchObject({ ok: true, kind: "metadata" });
    expect(check(`LIST DQ USL ${NS}.${USL}`)).toMatchObject({ ok: true, kind: "metadata" });
    expect(check(`SHOW DQ ALL INVALID TABLE ${T("customer")}`)).toMatchObject({ ok: true, kind: "show" });
    expect(check(`SHOW DQ INVALID RECORD dob_present TABLE ${T("customer")}`)).toMatchObject({
      ok: true,
      kind: "show",
    });
    expect(reason(`SHOW DQ INVALID RECORD x TABLE lightning.metastore.other.m.t`)).toBe("unsupported_statement");
  });
});

describe("guardSql: more than one statement", () => {
  it.each([
    "SELECT 1; SELECT 2",
    "SELECT 1;",
    `SELECT * FROM ${T("customer")}; DROP TABLE x`,
    "SELECT 1 ;--",
    "SELECT ';'",
  ])("rejects %s", (sql) => {
    expect(reason(sql)).toBe("multiple_statements");
  });
});

describe("guardSql: comments and hidden text", () => {
  it.each(["SELECT 1 -- x", "SELECT /* y */ 1", "SELECT 1 # z", "SELECT 'a -- b'"])("rejects %s", (sql) => {
    expect(reason(sql)).toBe("comment");
  });
  it("rejects control characters and NUL bytes", () => {
    expect(reason("SELECT 1\u0000")).toBe("control_character");
    expect(reason("SELECT\u001b 1")).toBe("control_character");
  });
});

describe("guardSql: only read-only statements", () => {
  it.each([
    "CREATE TABLE x (a int)",
    "DROP TABLE x",
    "INSERT INTO x VALUES (1)",
    "UPDATE x SET a = 1",
    "DELETE FROM x",
    "GRANT SELECT ON ALL TO USER 'a'",
    "ACTIVATE USL TABLE a.b.c AS SELECT 1",
    "REGISTER DQ r TABLE a.b.c AS a > 1",
    "CACHE TABLE x",
    "SET spark.x = 1",
    "WITH t AS (SELECT 1) SELECT * FROM t",
    "EXPLAIN QUERY AS SELECT 1",
  ])("rejects %s", (sql) => {
    expect(["not_read_only", "forbidden_keyword"]).toContain(reason(sql));
  });
  it("rejects a write hidden inside a select", () => {
    expect(reason(`SELECT * INTO x FROM ${T("customer")}`)).toBe("forbidden_keyword");
    expect(reason(`SELECT * FROM ${T("customer")} LATERAL VIEW explode(a) t AS b`)).toBe("forbidden_keyword");
  });
  it("lets a forbidden word appear inside a string value", () => {
    expect(check(`SELECT * FROM ${T("customer")} WHERE full_name = 'Drop Table Update'`).ok).toBe(true);
  });
  it("rejects dangerous functions", () => {
    expect(reason("SELECT reflect('java.lang.Runtime', 'getRuntime')")).toBe("forbidden_function");
    expect(reason("SELECT java_method('java.lang.System', 'exit', 1)")).toBe("forbidden_function");
  });
  it("rejects other SHOW, LOAD and LIST statements", () => {
    expect(reason("SHOW ROLES")).toBe("unsupported_statement");
    expect(reason("SHOW USERS")).toBe("unsupported_statement");
    expect(reason("SHOW NAMESPACES OR TABLES IN lightning.metastore")).toBe("unsupported_statement");
    expect(reason("LOAD USL other NAMESPACE lightning.metastore.sanctions")).toBe("unsupported_statement");
    expect(reason("LIST DQ USL lightning.metastore.other.model")).toBe("unsupported_statement");
    expect(reason(`SHOW DQ ALL INVALID TABLE lightning.metastore.other.model.t`)).toBe("unsupported_statement");
  });
});

describe("guardSql: only the allowed tables", () => {
  it("rejects tables outside the list, unqualified names and other databases", () => {
    expect(reason("SELECT * FROM customer")).toBe("table_not_allowed");
    expect(reason(`SELECT * FROM ${NS}.${USL}.payment`)).toBe("table_not_allowed");
    expect(reason("SELECT * FROM tpcds_db.store_sales")).toBe("table_not_allowed");
    expect(reason(`SELECT * FROM ${T("customer")} c JOIN secrets.keys k ON 1 = 1`)).toBe("table_not_allowed");
  });
  it("rejects comma joins and subqueries without an allowed table", () => {
    expect(reason(`SELECT * FROM ${T("customer")}, ${T("alert")}`)).toBe("table_not_allowed");
    expect(reason("SELECT * FROM (SELECT 1) t")).toBe("no_table");
  });
});

describe("guardSql: limits", () => {
  it("rejects empty and over-long statements", () => {
    expect(reason("   ")).toBe("empty");
    expect(reason(`SELECT '${"a".repeat(5000)}'`)).toBe("too_long");
    expect(guardSql(`SELECT '${"a".repeat(50)}'`, { ...options, maxLength: 20 })).toMatchObject({
      ok: false,
      code: "too_long",
    });
  });
});

describe("blankLiterals", () => {
  it("hides the inside of strings and keeps escaped quotes together", () => {
    expect(blankLiterals("a = 'O''Brien' AND b = 'x'")).toBe("a = 'xxxxxxxx' AND b = 'x'");
  });
});

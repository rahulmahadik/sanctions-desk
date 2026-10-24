import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scopeViolation } from "../src/client.js";
import { blankLiterals, guardSql } from "../src/guard.js";
import { parseUslModel } from "../src/metadata.js";
import { buildEvidenceTools, quoteLiteral } from "../src/tools.js";

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
        `select a.alert_id from ${T("alert")} a JOIN \`lightning\`.\`metastore\`.\`sanctions\`.\`${USL}\`.\`CUSTOMER\` c ON a.customer_id = c.customer_id WHERE c.full_name = 'Smith'`,
      ).ok,
    ).toBe(true);
    // One quoted name with dots in it is a single name to the engine, not the dotted path of an allowed table.
    expect(reason(`SELECT 1 FROM \`${NS}\`.\`${USL}\`.customer`)).toBe("unrecognised_table");
    expect(check(`SELECT 1 FROM ${T("customer").toUpperCase()} WHERE full_name = 'O''Brien'`).ok).toBe(true);
    expect(
      check(`SELECT COUNT(*) FROM ${T("alert")} a JOIN ${T("customer")} c ON a.customer_id = c.customer_id`).ok,
    ).toBe(true);
  });
  it("accepts a subquery that reads an allowed table", () => {
    expect(check(`SELECT 1 FROM (SELECT customer_id FROM ${T("customer")}) t`).ok).toBe(true);
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
    `SELECT 1 FROM ${T("customer")}; DROP TABLE x`,
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
    "WITH t AS (SELECT 1) SELECT 1 FROM t",
    "EXPLAIN QUERY AS SELECT 1",
  ])("rejects %s", (sql) => {
    expect(["not_read_only", "forbidden_keyword"]).toContain(reason(sql));
  });
  it("rejects a write hidden inside a select", () => {
    expect(reason(`SELECT 1 INTO x FROM ${T("customer")}`)).toBe("forbidden_keyword");
    expect(reason(`SELECT 1 FROM ${T("customer")} LATERAL VIEW explode(a) t AS b`)).toBe("forbidden_keyword");
  });
  it("lets a forbidden word appear inside a string value", () => {
    expect(check(`SELECT 1 FROM ${T("customer")} WHERE full_name = 'Drop Table Update'`).ok).toBe(true);
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
    expect(reason("SELECT 1 FROM customer")).toBe("table_not_allowed");
    expect(reason(`SELECT 1 FROM ${NS}.${USL}.payment`)).toBe("table_not_allowed");
    expect(reason("SELECT 1 FROM tpcds_db.store_sales")).toBe("table_not_allowed");
    expect(reason(`SELECT 1 FROM ${T("customer")} c JOIN secrets.keys k ON 1 = 1`)).toBe("table_not_allowed");
  });
  it("reads every table of a comma join, and refuses a subquery without an allowed table", () => {
    expect(check(`SELECT 1 FROM ${T("customer")}, ${T("alert")}`)).toMatchObject({
      ok: true,
      tables: [T("customer"), T("alert")],
    });
    expect(reason(`SELECT 1 FROM ${T("customer")}, other.users`)).toBe("table_not_allowed");
    expect(reason("SELECT 1 FROM (SELECT 1) t")).toBe("no_table");
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
  it("keeps a backslash and the character after it inside the literal", () => {
    expect(blankLiterals("a = 'x\\' OR b = 'y'")).toBe("a = 'xxxxxxxxxxx'y'");
  });
});

describe("guardSql: every table in every FROM form", () => {
  const other = "other.users";
  it.each([
    ["a comma join after an alias", `SELECT 1 FROM ${T("customer")} c, ${other} u`],
    ["a comma join after an alias with AS", `SELECT 1 FROM ${T("customer")} AS c, ${other} u`],
    ["a join then an aliased comma join", `SELECT 1 FROM ${T("customer")} a JOIN ${T("alert")} b ON 1=1, ${other}`],
    ["a comma after a join condition", `SELECT 1 FROM ${T("customer")} a JOIN ${T("alert")} b ON a.x = b.x, ${other}`],
    ["a third table in a comma list", `SELECT 1 FROM ${T("customer")} a, ${T("alert")} b, ${other} c`],
    ["an inner join", `SELECT 1 FROM ${T("customer")} a INNER JOIN ${other} b ON 1=1`],
    ["a left outer join", `SELECT 1 FROM ${T("customer")} a LEFT OUTER JOIN ${other} b ON 1=1`],
    ["a right join", `SELECT 1 FROM ${T("customer")} a RIGHT JOIN ${other} b ON 1=1`],
    ["a full outer join", `SELECT 1 FROM ${T("customer")} a FULL OUTER JOIN ${other} b ON 1=1`],
    ["a left semi join", `SELECT 1 FROM ${T("customer")} a LEFT SEMI JOIN ${other} b ON 1=1`],
    ["a cross join", `SELECT 1 FROM ${T("customer")} a CROSS JOIN ${other}`],
    ["a natural join", `SELECT 1 FROM ${T("customer")} NATURAL JOIN ${other}`],
    ["a join with USING", `SELECT 1 FROM ${T("customer")} a JOIN ${other} b USING (customer_id)`],
    ["a lateral join", `SELECT 1 FROM ${T("customer")} a JOIN LATERAL (SELECT 1 FROM ${other}) b`],
    ["a bracketed join", `SELECT 1 FROM (${T("customer")} a JOIN ${other} b ON 1=1)`],
    ["a bracketed comma list", `SELECT 1 FROM (${T("customer")} a, ${other} b)`],
    ["a subquery in FROM", `SELECT 1 FROM (SELECT 1 FROM ${other}) s`],
    ["a subquery after an allowed table", `SELECT 1 FROM ${T("customer")} c, (SELECT 1 FROM ${other}) s`],
    ["a subquery in WHERE", `SELECT 1 FROM ${T("customer")} WHERE a = (SELECT max(a) FROM ${other})`],
    ["a subquery in IN", `SELECT 1 FROM ${T("customer")} WHERE a IN (SELECT a FROM ${other})`],
    ["a subquery in EXISTS", `SELECT 1 FROM ${T("customer")} c WHERE EXISTS (SELECT 1 FROM ${other} u)`],
    ["a subquery in the select list", `SELECT (SELECT max(a) FROM ${other}) AS m FROM ${T("customer")}`],
    [
      "a subquery in a join condition",
      `SELECT 1 FROM ${T("customer")} a JOIN ${T("alert")} b ON b.x IN (SELECT x FROM ${other})`,
    ],
    ["a query that starts with FROM", `SELECT 1 FROM ${T("customer")} WHERE a IN (FROM ${other} SELECT a)`],
    ["a TABLE query", `SELECT 1 FROM ${T("customer")} WHERE a IN (TABLE ${other})`],
    ["a union", `SELECT a FROM ${T("customer")} UNION SELECT a FROM ${other}`],
    ["an intersect", `SELECT a FROM ${T("customer")} INTERSECT SELECT a FROM ${other}`],
    ["an except", `SELECT a FROM ${T("customer")} EXCEPT SELECT a FROM ${other}`],
    ["a bracketed union", `(SELECT a FROM ${T("customer")}) UNION ALL (SELECT a FROM ${other})`],
    ["a common table expression", `WITH x AS (SELECT 1 FROM ${other}) SELECT 1 FROM x`],
    [
      "a common table expression that shadows a table",
      `WITH customer AS (SELECT 1 FROM ${other}) SELECT 1 FROM customer`,
    ],
    ["a nested common table expression", `SELECT 1 FROM (WITH x AS (SELECT 1 FROM ${other}) SELECT 1 FROM x) s`],
    [
      "a common table expression named like an allowed table",
      `SELECT 1 FROM (WITH \`${T("customer")}\` AS (SELECT 1 FROM ${other}) SELECT 1 FROM \`${T("customer")}\`) s`,
    ],
    ["a one-part name", "SELECT 1 FROM users"],
    ["a two-part name", "SELECT 1 FROM a.b"],
    ["a three-part name", "SELECT 1 FROM catalog.schema.users"],
    ["a four-part name", `SELECT 1 FROM ${NS}.users`],
    ["a six-part name", `SELECT 1 FROM ${T("customer")}.extra`],
    ["a backquoted dotted name", `SELECT 1 FROM \`${T("customer")}\``],
    ["a double-quoted dotted name", `SELECT 1 FROM "${T("customer")}"`],
    ["a bracket-quoted name", "SELECT 1 FROM [lightning].[metastore].[sanctions].[screening_usl].[customer]"],
    ["a bracket-quoted name after a join", `SELECT 1 FROM ${T("customer")} c JOIN [other].[users] u ON 1=1`],
    ["a backquoted name with an escaped quote", `SELECT 1 FROM ${NS}.${USL}.\`cust\`\`omer\``],
    ["a double-quoted name with an escaped quote", `SELECT 1 FROM ${NS}.${USL}."cust""omer"`],
    ["a table function", "SELECT 1 FROM range(10)"],
    ["a name given by a function", "SELECT 1 FROM IDENTIFIER('other.users')"],
    ["a file read", "SELECT 1 FROM json.`/tmp/x`"],
    ["a table sample", `SELECT 1 FROM ${T("customer")} TABLESAMPLE (10 PERCENT)`],
    ["a pivot", `SELECT 1 FROM ${T("customer")} PIVOT (count(a) FOR a IN (1, 2))`],
    ["a time travel clause", `SELECT 1 FROM ${T("customer")} VERSION AS OF 1`],
    ["a FROM with nothing after it", "SELECT 1 FROM"],
    ["a number glued to a keyword", `SELECT 1e5FROM ${other}`],
    [
      "a column named like a clause, then a comma join",
      `SELECT 1 FROM ${T("customer")} a JOIN ${T("alert")} b ON a.x = b.sort, ${other}`,
    ],
    [
      "a clause word used as a column, then a comma join",
      `SELECT 1 FROM ${T("customer")} a JOIN ${T("alert")} b ON a.x = offset, ${other}`,
    ],
    ["a clause word used as an alias, then a comma join", `SELECT 1 FROM ${T("customer")} limit, ${other}`],
    ["an unbalanced bracket", `SELECT 1 FROM (${T("customer")}`],
    ["an extra closing bracket", `SELECT 1 FROM ${T("customer")})`],
    ["a variable substitution", `SELECT 1 FROM \${hivevar:t}`],
    ["a variable substitution inside a value", `SELECT 1 FROM ${T("customer")} WHERE a = '\${x}'`],
    ["a parameter marker", `SELECT 1 FROM ${T("customer")} WHERE a = ?`],
  ])("refuses %s", (_name, sql) => {
    expect(check(sql).ok).toBe(false);
  });

  it.each([
    [
      "a comma join with aliases",
      `SELECT 1 FROM ${T("customer")} c, ${T("alert")} a WHERE c.customer_id = a.customer_id`,
    ],
    [
      "several join kinds",
      `SELECT 1 FROM ${T("customer")} c LEFT OUTER JOIN ${T("alert")} a ON 1=1 CROSS JOIN ${T("list_entry")} e`,
    ],
    ["a bracketed join", `SELECT 1 FROM (${T("customer")} c JOIN ${T("alert")} a ON c.x = a.x) j`],
    ["a subquery with a column alias list", `SELECT 1 FROM (SELECT a, b FROM ${T("customer")}) AS s(x, y)`],
    ["a union of allowed tables", `SELECT a FROM ${T("customer")} UNION SELECT a FROM ${T("alert")}`],
    ["quoted parts of an allowed table", `SELECT 1 FROM "lightning"."metastore".\`sanctions\`.screening_usl."ALERT"`],
    ["a value that looks like a table", `SELECT 1 FROM ${T("customer")} WHERE note = 'x, other.users JOIN y'`],
    ["a column named like a clause", `SELECT 1 FROM ${T("customer")} c WHERE c.sort = 1 ORDER BY c.order, c.limit`],
    ["functions with commas", `SELECT coalesce(a, 'b'), substr(c, 1, 2) FROM ${T("customer")} x, ${T("alert")} y`],
    ["a window", `SELECT row_number() OVER (PARTITION BY a, b ORDER BY c) AS r FROM ${T("customer")}`],
    ["non-ASCII inside a value", `SELECT 1 FROM ${T("customer")} WHERE full_name = 'Müller 王'`],
  ])("accepts %s", (_name, sql) => {
    expect(check(sql)).toMatchObject({ ok: true });
  });

  it("names every table it read, once, in lower case", () => {
    const v = check(
      `SELECT 1 FROM ${T("CUSTOMER")} c, ${T("alert")} a WHERE a.x IN (SELECT x FROM ${T("list_entry")}) AND c.y IN (SELECT y FROM ${T("customer")})`,
    );
    expect(v.ok && [...v.tables].sort()).toEqual([T("alert"), T("customer"), T("list_entry")]);
  });

  it("gives a clear code when a table position cannot be read", () => {
    expect(reason("SELECT 1 FROM [other].[users]")).toBe("unrecognised_table");
    expect(reason("SELECT 1 FROM range(10)")).toBe("unrecognised_table");
    expect(reason(`SELECT 1 FROM \`${T("customer")}\``)).toBe("unrecognised_table");
    expect(reason(`SELECT 1 FROM ${T("customer")} limit, other.users`)).toBe("unrecognised_table");
    expect(reason(`SELECT 1 FROM (${T("customer")}`)).toBe("unbalanced_brackets");
    expect(reason("WITH x AS (SELECT 1) SELECT 1 FROM x")).toBe("not_read_only");
    expect(reason("SELECT 1 FROM (WITH x AS (SELECT 1) SELECT 1 FROM x) s")).toBe("forbidden_keyword");
  });
});

describe("guardSql: characters outside string values", () => {
  it.each([
    ["a Cyrillic letter in a keyword", `SЕLECT * FROM ${T("customer")}`],
    ["a Cyrillic letter in a table name", `SELECT 1 FROM ${NS}.${USL}.сustomer`],
    ["a full-width letter", `SELECT 1 FROM ${T("customer")} ＷHERE 1=1`],
    ["a zero-width space", `SELECT 1 FROM ${T("customer")}​, other.users`],
    ["a zero-width joiner in a name", `SELECT 1 FROM ${T("cust‍omer")}`],
    ["a bidirectional override", `SELECT 1 FROM ${T("customer")} WHERE a = 1 ‮`],
    ["a no-break space", `SELECT * FROM ${T("customer")}`],
    ["non-ASCII in a quoted name", `SELECT 1 FROM ${NS}.${USL}.\`custömer\``],
    ["a byte order mark", `﻿SELECT 1 FROM ${T("customer")}`],
  ])("refuses %s", (_name, sql) => {
    expect(reason(sql)).toBe("non_ascii");
  });

  it("refuses a backslash anywhere, so a string cannot end where the guard does not expect", () => {
    expect(
      reason(`SELECT 1 FROM ${T("customer")} WHERE a = 'x\\' OR 1 IN (SELECT 1 FROM other.users) OR b = \\'y'`),
    ).toBe("backslash");
    expect(reason(`SELECT 1 FROM ${T("customer")} WHERE a = 'abc\\'`)).toBe("backslash");
    expect(reason(`SELECT 1 FROM ${T("customer")} WHERE a = 'a\\nb'`)).toBe("backslash");
  });

  it("refuses an unclosed quote", () => {
    expect(reason(`SELECT 1 FROM ${T("customer")} WHERE a = 'x`)).toBe("unbalanced_quote");
    expect(reason(`SELECT 1 FROM ${T("customer")} WHERE \`a = 1`)).toBe("unbalanced_quote");
  });

  it("keeps a doubled quote inside one value", () => {
    const v = check(`SELECT 1 FROM ${T("customer")} WHERE a = 'x'' OR 1 IN (SELECT 1 FROM other.users) OR ''y'`);
    expect(v).toMatchObject({ ok: true, tables: [T("customer")] });
  });
});

describe("quoteLiteral agrees with the guard", () => {
  it("refuses a backslash and a substitution, and its output always passes the guard", () => {
    expect(() => quoteLiteral("abc\\")).toThrow(/not allowed/);
    expect(() => quoteLiteral(`\${x}`)).toThrow(/not allowed/);
    for (const value of ["O'Brien", "''", "x' OR '1'='1", "a, other.users JOIN b", "Müller"]) {
      const v = check(`SELECT 1 FROM ${T("customer")} WHERE a = ${quoteLiteral(value)}`);
      expect(v).toMatchObject({ ok: true, tables: [T("customer")] });
    }
  });
});

describe("scopeViolation: an agent's own tables", () => {
  it("sees the second table of a comma join after an alias", () => {
    const scope = { agent: "screener", tables: ["customer"], denyColumns: [] };
    const v = check(`SELECT 1 FROM ${T("customer")} c, ${T("alert")} a`);
    expect(v.ok).toBe(true);
    if (v.ok) expect(scopeViolation(scope, v.tables, v.sql)).toMatch(/may not read alert/);
  });
});

describe("guardSql: every statement shape the application sends", () => {
  type Cache = { entries: Record<string, { sql: string; body: string }> };
  const cache = JSON.parse(
    readFileSync(new URL("../../../data/sample/query-cache.json", import.meta.url), "utf8"),
  ) as Cache;
  const recorded = Object.values(cache.entries);
  const load = recorded.find((e) => e.sql.startsWith("LOAD USL"));
  const cell = (JSON.parse(load?.body ?? "{}") as { data?: string[][] }).data?.[0]?.[0] ?? "{}";
  const model = parseUslModel(JSON.parse(cell));
  const live = {
    namespace: NS,
    usl: USL,
    allowedTables: model.tables.filter((t) => t.activated).map((t) => t.qualifiedName),
  };
  const q = (name: string) => `${NS}.${USL}.${name}`;

  it("passes every statement recorded from real runs, and reads exactly the tables it names", () => {
    expect(recorded.length).toBeGreaterThan(100);
    for (const { sql } of recorded) {
      const v = guardSql(sql, live);
      expect(v, sql).toMatchObject({ ok: true });
      const named = [...sql.matchAll(/(?:FROM|JOIN|TABLE) (lightning\.[\w.]+)/g)].map((m) => m[1]);
      if (v.ok) expect([...v.tables].sort(), sql).toEqual([...new Set(named)].sort());
    }
  });

  it("passes the statements the evidence tools build, for every table and filter shape", async () => {
    const sent: string[] = [];
    const client = {
      query: async (_role: string, sql: string) => {
        sent.push(sql);
        return { objects: [], rows: [], headers: [] };
      },
    } as unknown as Parameters<typeof buildEvidenceTools>[1];
    const tools = buildEvidenceTools(model, client, { role: "evidence", defaultLimit: 50, maskSensitive: true });
    for (const tool of tools.values()) {
      const [a, b] = tool.columns as [string, string | undefined];
      await tool.find({ [a]: "CUST-0001" });
      if (b) await tool.find({ [a]: "O'Brien", [b]: "x" }, { limit: 5 });
    }
    expect(sent.length).toBeGreaterThan(10);
    for (const sql of sent) expect(guardSql(sql, live), sql).toMatchObject({ ok: true });
  });

  it("passes the metadata, quality, list change, queue, ownership and identifier overlap shapes", () => {
    const list = ["CUST-0051", "CUST-0052"].map(quoteLiteral).join(", ");
    const norm = (c: string) => `regexp_replace(upper(${c}), '[^A-Z0-9]', '')`;
    const statements = [
      `LOAD USL ${USL} NAMESPACE ${NS}`,
      `LIST DQ USL ${NS}.${USL}`,
      `SHOW NAMESPACES OR TABLES IN ${NS}`,
      `SHOW DQ ALL INVALID TABLE ${q("customer")}`,
      `SHOW DQ INVALID RECORD dob_present_for_individuals TABLE ${q("customer")}`,
      `SELECT ci.id_type AS id_type, COUNT(*) AS n FROM ${q("customer_identifier")} ci JOIN ${q("list_identifier")} li ON ${norm("ci.id_number")} = ${norm("li.id_number")} WHERE ci.customer_id = ${quoteLiteral("CUST-0001")} AND li.entry_id = ${quoteLiteral("OFAC-1")} GROUP BY ci.id_type`,
      `SELECT \`alert_id\`, \`customer_id\`, \`entry_id\` FROM ${q("alert")} WHERE \`status\` = 'open' AND \`customer_id\` IN (${list})`,
      `SELECT \`payment_id\`, \`amount\`, \`currency\` FROM ${q("payment")} WHERE \`status\` = 'pending' AND \`customer_id\` IN (${list})`,
      `SELECT \`ownership_id\`, \`owned_party_id\` FROM ${q("beneficial_owner")} WHERE \`owned_party_id\` IN (${list}) ORDER BY \`ownership_id\``,
      `SELECT \`disposition_id\`, \`decision\` FROM ${q("disposition")} ORDER BY \`disposition_id\``,
      `SELECT \`alert_id\`, \`status\` FROM ${q("alert")} ORDER BY \`alert_id\` LIMIT 200`,
      `SELECT definition_key, definition_id, version, name, statement, status, owner, effective_from FROM ${q("business_definition")}`,
      `SELECT p.customer_id, COUNT(*) AS pending_payments, SUM(p.amount) AS pending_amount FROM ${q("payment")} p WHERE p.status = 'pending' AND p.customer_id IN (${list}) GROUP BY p.customer_id`,
    ];
    for (const sql of statements) expect(guardSql(sql, live), sql).toMatchObject({ ok: true });
  });
});

describe("every column by wildcard", () => {
  it.each([
    `SELECT * FROM ${T("customer")} WHERE customer_id = 'X'`,
    `SELECT c.* FROM ${T("customer")} c WHERE c.customer_id = 'X'`,
    `SELECT DISTINCT * FROM ${T("customer")}`,
    `SELECT customer_id, * FROM ${T("customer")}`,
    `SELECT 1 FROM ${T("alert")} WHERE customer_id IN (SELECT * FROM ${T("customer")})`,
  ])("refuses %s, so a denied column can never be read by accident", (sql) => {
    expect(reason(sql)).toBe("select_star");
  });

  it("still allows COUNT(*) and multiplication", () => {
    expect(check(`SELECT COUNT(*) FROM ${T("customer")}`).ok).toBe(true);
    expect(check(`SELECT score * 2 FROM ${T("alert")}`).ok).toBe(true);
  });
});

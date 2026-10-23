import { describe, expect, it } from "vitest";
import { guardSql } from "../src/guard.js";

/**
 * Generated statements: every FROM form the guard reads, filled with allowed and other table names in every
 * quoting style, with random keyword case and spacing. A statement must be refused exactly when it names a table
 * outside the allowed list, and when it is accepted the guard must report exactly the tables it names.
 */

const NS = ["lightning", "metastore", "sanctions"];
const USL = "screening_usl";
const ALLOWED = ["customer", "alert", "list_entry"].map((t) => [...NS, USL, t]);
const OTHER = [
  ["other", "users"],
  ["users"],
  ["customer"],
  ["catalog", "schema", "users"],
  [...NS, "users"],
  [...NS, USL, "payment"],
  [...NS, "other_usl", "customer"],
  [...NS, USL, "customer", "extra"],
  [...NS, USL, "customer_identifier"],
  ["spark_catalog", "default", "secrets"],
];
const options = { namespace: NS.join("."), usl: USL, allowedTables: ALLOWED.map((p) => p.join(".")) };

const JOINS = [
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "LEFT OUTER JOIN",
  "RIGHT JOIN",
  "RIGHT OUTER JOIN",
  "FULL JOIN",
  "FULL OUTER JOIN",
  "LEFT SEMI JOIN",
  "LEFT ANTI JOIN",
];
const SET_OPS = ["UNION", "UNION ALL", "UNION DISTINCT", "INTERSECT", "EXCEPT"];

/** Templates; {0}, {1}, {2} are tables, {J} a join, {S} a set operation. Tokens are separated by single spaces. */
const TEMPLATES = [
  "SELECT * FROM {0}",
  "SELECT * FROM {0} x",
  "SELECT * FROM {0} AS x",
  "SELECT x.a , y.b FROM {0} x , {1} y WHERE x.id = y.id",
  "SELECT * FROM {0} , {1}",
  "SELECT * FROM {0} AS x , {1} AS y , {2}",
  "SELECT * FROM {0} x {J} {1} y ON x.id = y.id",
  "SELECT * FROM {0} {J} {1} ON 1 = 1",
  "SELECT * FROM {0} x CROSS JOIN {1} y",
  "SELECT * FROM {0} NATURAL JOIN {1}",
  "SELECT * FROM {0} x JOIN {1} y USING ( id )",
  "SELECT * FROM {0} x {J} {1} y ON x.id = y.id , {2} z",
  "SELECT * FROM {0} x , {1} y {J} {2} z ON y.id = z.id",
  "SELECT * FROM ( SELECT id FROM {0} ) s",
  "SELECT * FROM ( SELECT x.id FROM {0} x {J} {1} y ON x.id = y.id ) s , {2} t",
  "SELECT * FROM ( {0} x {J} {1} y ON x.id = y.id )",
  "SELECT * FROM ( {0} x , {1} y ) j",
  "SELECT * FROM {0} WHERE id IN ( SELECT id FROM {1} )",
  "SELECT * FROM {0} x WHERE EXISTS ( SELECT 1 FROM {1} y WHERE y.id = x.id )",
  "SELECT * FROM {0} x WHERE NOT EXISTS ( SELECT 1 FROM {1} y , {2} z WHERE y.id = z.id )",
  "SELECT ( SELECT max(id) FROM {0} ) AS m , x.id FROM {1} x",
  "SELECT id FROM {0} {S} SELECT id FROM {1}",
  "( SELECT id FROM {0} ) {S} ( SELECT id FROM {1} )",
  "SELECT id FROM {0} {S} SELECT id FROM {1} {S} SELECT id FROM {2}",
  "SELECT * FROM {0} WHERE id IN ( SELECT id FROM {1} WHERE id IN ( SELECT id FROM {2} ) )",
  "SELECT coalesce(x.a, 'b') , x.c FROM {0} x , {1} y WHERE x.note = 'z FROM other.users , q' ORDER BY x.c , y.d LIMIT 5",
  "SELECT x.id , count(*) AS n FROM {0} x LEFT JOIN {1} y ON x.id = y.id AND y.k IN ( 1 , 2 ) GROUP BY x.id HAVING count(*) > 1",
  "SELECT * FROM {0} x {J} {1} y ON x.id IN ( SELECT id FROM {2} )",
  "SELECT * FROM {0} x WHERE x.sort = 1 ORDER BY x.a , x.b",
];
const KEYWORDS = new Set(
  "SELECT FROM JOIN AS WHERE ON CROSS NATURAL USING IN EXISTS NOT UNION ALL DISTINCT INTERSECT EXCEPT LEFT RIGHT FULL OUTER INNER SEMI ANTI ORDER BY LIMIT GROUP HAVING AND".split(
    " ",
  ),
);
const SPACES = [" ", " ", " ", "  ", "\n", "\t", " \n  ", "\r\n"];

/** Deterministic random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const casing = (word: string): string =>
    pick([word.toUpperCase(), word.toLowerCase(), word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()]);
  const renderPart = (part: string, style: string): string => {
    const shown = next() < 0.3 ? part.toUpperCase() : part;
    if (style === "backtick") return `\`${shown}\``;
    if (style === "double") return `"${shown}"`;
    return shown;
  };
  const renderTable = (parts: readonly string[]): string => {
    const style = pick(["plain", "plain", "backtick", "double", "mixed"]);
    return parts.map((p) => renderPart(p, style === "mixed" ? pick(["plain", "backtick", "double"]) : style)).join(".");
  };

  return function statement(): { sql: string; tables: string[]; outside: boolean } {
    const template = pick(TEMPLATES);
    const tables: string[][] = [];
    const filled = template
      .replace(/\{J\}/g, () => pick(JOINS))
      .replace(/\{S\}/g, () => pick(SET_OPS))
      .replace(/\{(\d)\}/g, () => {
        const parts = next() < 0.7 ? pick(ALLOWED) : pick(OTHER);
        tables.push(parts);
        return renderTable(parts);
      });
    const sql = filled
      .split(" ")
      .map((token) => (KEYWORDS.has(token) ? casing(token) : token))
      .reduce((acc, token, i) => (i === 0 ? token : acc + pick(SPACES) + token), "");
    const names = tables.map((p) => p.join(".").toLowerCase());
    return { sql, tables: [...new Set(names)], outside: names.some((n) => !options.allowedTables.includes(n)) };
  };
}

describe("SQL guard: generated statements", () => {
  const statement = generator(20261024);
  const cases = Array.from({ length: 3000 }, statement);

  it("covers both outcomes in quantity", () => {
    expect(cases.filter((c) => c.outside).length).toBeGreaterThan(1000);
    expect(cases.filter((c) => !c.outside).length).toBeGreaterThan(500);
  });

  /** What is wrong with the verdict on one generated statement, or undefined when it is right. */
  const mistake = (c: { sql: string; tables: string[]; outside: boolean }): string | undefined => {
    const v = guardSql(c.sql, options);
    if (!v.ok) {
      if (!c.outside) return `refused (${v.code}: ${v.reason}): ${c.sql}`;
      return v.code === "table_not_allowed" ? undefined : `refused with ${v.code}: ${c.sql}`;
    }
    if (c.outside) return `accepted: ${c.sql}`;
    const same = [...v.tables].sort().join() === [...c.tables].sort().join();
    return same ? undefined : `tables ${v.tables.join()} instead of ${c.tables.join()}: ${c.sql}`;
  };

  it("refuses a statement exactly when it names a table outside the list, and reports the tables it read", () => {
    const wrong = cases.map(mistake).filter((m) => m !== undefined);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it("refuses every accepted statement once a hiding trick is added", () => {
    const tricks: Array<(sql: string) => string> = [
      (sql) => sql.replace(/lightning/i, "[lightning]"),
      (sql) => sql.replace(/\bfrom\b/i, (m) => `${m}​`),
      (sql) => sql.replace(/\bselect\b/i, (m) => m.replace(/e/i, "е")),
      (sql) => `WITH c AS (SELECT 1) ${sql}`,
      (sql) => `${sql.replace(/^\(\s*/, "")} -- x`,
      (sql) => sql.replace(/screening_usl/i, "`screening``usl`"),
      (sql) => `SELECT * FROM (${sql}) s WHERE s.a = 'x\\'`,
      (sql) => `${sql.replace(/^\(\s*/, "")}; SELECT 1`,
    ];
    const accepted = cases.filter((c) => !c.outside).slice(0, 400);
    const next = random(7);
    const leaked: string[] = [];
    for (const c of accepted) {
      const trick = tricks[Math.floor(next() * tricks.length)] as (sql: string) => string;
      const sql = trick(c.sql);
      if (sql !== c.sql && guardSql(sql, options).ok) leaked.push(sql);
    }
    expect(leaked.slice(0, 5)).toEqual([]);
  });
});

/**
 * The SQL guard: the second layer in front of Zetaris. Zetaris enforces what each identity may do; this
 * guard makes sure an agent can only ever send one read-only statement that touches the allowed
 * semantic-layer tables. It runs before every request and rejects instead of repairing.
 */

export type StatementKind = "select" | "show" | "metadata";

export interface GuardOptions {
  /** Fully qualified, e.g. "lightning.metastore.sanctions.screening_usl.customer". Compared case-insensitively. */
  allowedTables: readonly string[];
  /** The namespace and model the agents may inspect, e.g. "lightning.metastore.sanctions" and "screening_usl". */
  namespace: string;
  usl: string;
  maxLength?: number;
}

export type GuardVerdict =
  | { ok: true; kind: StatementKind; sql: string; tables: string[] }
  | { ok: false; reason: string; code: GuardCode };

export type GuardCode =
  | "empty"
  | "too_long"
  | "multiple_statements"
  | "comment"
  | "control_character"
  | "not_read_only"
  | "forbidden_keyword"
  | "forbidden_function"
  | "table_not_allowed"
  | "no_table"
  | "unsupported_statement"
  | "agent_scope";

const DEFAULT_MAX_LENGTH = 4000;

/** Words that start or hide a statement that changes something. Matched as whole words outside string literals. */
const FORBIDDEN_WORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "create",
  "alter",
  "truncate",
  "merge",
  "grant",
  "revoke",
  "replace",
  "into",
  "call",
  "exec",
  "execute",
  "set",
  "use",
  "load",
  "export",
  "materialize",
  "activate",
  "register",
  "cache",
  "uncache",
  "refresh",
  "invalidate",
  "assign",
  "outfile",
  "lateral",
] as const;
const FORBIDDEN_FUNCTIONS = [
  "reflect",
  "java_method",
  "try_reflect",
  "raise_error",
  "input_file_name",
  "assert_true",
] as const;

/** Replace the inside of every string literal so that words and symbols inside values are not mistaken for SQL. */
export function blankLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => `'${"x".repeat(Math.max(0, m.length - 2))}'`);
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
}

function reject(code: GuardCode, reason: string): GuardVerdict {
  return { ok: false, code, reason };
}

const unquote = (id: string): string => id.replace(/[`"]/g, "").toLowerCase();

/** Table names that follow FROM or JOIN, with their quotes removed. */
function referencedTables(blanked: string): { tables: string[]; commaJoin: boolean; subqueryOnly: boolean } {
  const tables: string[] = [];
  let commaJoin = false;
  const pattern = /\b(?:from|join)\s+([`"]?[A-Za-z_][\w`".]*)(\s*,)?/gi;
  for (const m of blanked.matchAll(pattern)) {
    tables.push(unquote(m[1] as string));
    if (m[2]) commaJoin = true;
  }
  // "FROM (" starts a subquery, whose own FROM is matched by the pattern above.
  const subqueryOnly = tables.length === 0 && /\b(?:from|join)\s*\(/i.test(blanked);
  return { tables, commaJoin, subqueryOnly };
}

/** Checks that apply to every statement, before it is read as SQL. */
function precheck(text: string, maxLength: number): GuardVerdict | undefined {
  if (text === "") return reject("empty", "the statement is empty");
  if (text.length > maxLength) return reject("too_long", "the statement is too long");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return reject("control_character", "the statement contains a control character");
  }
  if (text.includes(";"))
    return reject("multiple_statements", "only one statement per call; semicolons are not allowed");
  if (/--|\/\*|\*\/|#/.test(text)) return reject("comment", "comments are not allowed in a statement");
  return undefined;
}

function guardSelect(text: string, blanked: string, words: readonly string[], options: GuardOptions): GuardVerdict {
  const forbidden = words.find((word) => (FORBIDDEN_WORDS as readonly string[]).includes(word));
  if (forbidden) return reject("forbidden_keyword", `"${forbidden}" is not allowed in a read-only query`);
  const fn = FORBIDDEN_FUNCTIONS.find((name) => new RegExp(`\\b${name}\\s*\\(`, "i").test(blanked));
  if (fn) return reject("forbidden_function", `function "${fn}" is not allowed`);

  const { tables, commaJoin, subqueryOnly } = referencedTables(blanked);
  if (commaJoin) return reject("table_not_allowed", "comma joins are not allowed; use an explicit JOIN");
  if (tables.length === 0) {
    return subqueryOnly
      ? reject("no_table", "a subquery must read an allowed table")
      : { ok: true, kind: "select", sql: text, tables: [] };
  }
  const allowed = new Set(options.allowedTables.map((t) => t.toLowerCase()));
  const outside = tables.find((table) => !allowed.has(table));
  if (outside) return reject("table_not_allowed", `table "${outside}" is not in the allowed list`);
  return { ok: true, kind: "select", sql: text, tables: [...new Set(tables)] };
}

export function guardSql(sql: string, options: GuardOptions): GuardVerdict {
  const text = sql.trim();
  const refused = precheck(text, options.maxLength ?? DEFAULT_MAX_LENGTH);
  if (refused) return refused;

  const blanked = blankLiterals(text);
  const words = wordsOf(blanked);
  const first = words[0];
  const model = `${options.namespace}.${options.usl}`.toLowerCase();

  if (first === "load")
    return guardMetadata(text, `load usl ${options.usl} namespace ${options.namespace}`.toLowerCase());
  if (first === "list") return guardMetadata(text, `list dq usl ${model}`);
  if (first === "show") return guardShow(text, options, model);
  if (first !== "select") return reject("not_read_only", "only SELECT, SHOW and USL metadata statements are allowed");
  return guardSelect(text, blanked, words, options);
}

function guardMetadata(text: string, expected: string): GuardVerdict {
  const normal = text.toLowerCase().replace(/\s+/g, " ");
  return normal === expected
    ? { ok: true, kind: "metadata", sql: text, tables: [] }
    : reject("unsupported_statement", `only "${expected}" is allowed`);
}

function guardShow(text: string, options: GuardOptions, model: string): GuardVerdict {
  const normal = text.toLowerCase().replace(/\s+/g, " ");
  const namespaces = `show namespaces or tables in ${options.namespace.toLowerCase()}`;
  if (normal === namespaces) return { ok: true, kind: "show", sql: text, tables: [] };
  const table = `${escapeRegExp(model)}\\.[a-z_][a-z0-9_]*`;
  const invalid = new RegExp(`^show dq all invalid table (${table})$`);
  const record = new RegExp(`^show dq (?:valid|invalid) record [a-z_][a-z0-9_]* table (${table})$`);
  const match = invalid.exec(normal) ?? record.exec(normal);
  if (match) return { ok: true, kind: "show", sql: text, tables: [match[1] as string] };
  return reject("unsupported_statement", "this SHOW statement is not allowed");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

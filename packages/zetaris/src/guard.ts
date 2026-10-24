/**
 * The SQL guard: the second layer in front of Zetaris. Zetaris enforces what each identity may do; this
 * guard makes sure an agent can only ever send one read-only statement that touches the allowed
 * semantic-layer tables. It runs before every request and rejects instead of repairing.
 *
 * The statement is split into tokens the way a Spark-style engine reads it, and every place a table can be named
 * (after FROM, after JOIN, after a comma in a FROM list, inside brackets in a FROM list) is read in full. Anything
 * the guard cannot account for in those places is refused rather than guessed at.
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
  | "non_ascii"
  | "backslash"
  | "forbidden_character"
  | "unbalanced_quote"
  | "unbalanced_brackets"
  | "not_read_only"
  | "forbidden_keyword"
  | "forbidden_function"
  | "table_not_allowed"
  | "unrecognised_table"
  | "no_table"
  | "unsupported_statement"
  | "select_star"
  | "agent_scope";

const DEFAULT_MAX_LENGTH = 4000;

/** Words that start or hide a statement that changes something, or that read a table outside FROM. */
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
  // A common table expression can shadow a table name, and `TABLE x` reads a table without FROM.
  "with",
  "table",
] as const;
const FORBIDDEN_FUNCTIONS = [
  "reflect",
  "java_method",
  "try_reflect",
  "raise_error",
  "input_file_name",
  "assert_true",
] as const;

/** Words that may follow a table (or its alias) in a FROM list. */
const JOIN_WORDS = ["join", "inner", "left", "right", "full", "cross", "natural", "outer", "semi", "anti"];
const CLAUSE_WORDS = [
  "where",
  "group",
  "having",
  "order",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
  "minus",
  "window",
  "qualify",
  "sort",
  "cluster",
  "distribute",
  "select",
];
const AFTER_RELATION = new Set([...JOIN_WORDS, ...CLAUSE_WORDS, "on", "using"]);
const CLAUSE_END = new Set(CLAUSE_WORDS);
const BY_CLAUSES = new Set(["group", "order", "sort", "cluster", "distribute"]);
/** Words after which the next word is an operand, so a clause word there is really a column name. */
const EXPECTS_OPERAND = new Set([
  "and",
  "or",
  "not",
  "on",
  "is",
  "in",
  "like",
  "ilike",
  "rlike",
  "regexp",
  "between",
  "case",
  "when",
  "then",
  "else",
  "as",
  "by",
  "distinct",
  "all",
  "any",
  "some",
  "exists",
  "using",
  "join",
  "from",
  "select",
  "where",
  "having",
  "interval",
  "escape",
  "div",
  "collate",
]);
/** A bracket in a table position that opens a query rather than a list of tables. */
const QUERY_START = new Set(["select", "from", "values"]);
const PUNCTUATION = new Set("(),.*=<>!+-/%|&^~[]:");
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:bd|[lsydf])?/iy;
const WORD = /[A-Za-z0-9_]+/y;

function matchAt(pattern: RegExp, text: string, at: number): string {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? "";
}

type Token =
  | { kind: "word"; value: string }
  | { kind: "quoted"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "punct"; value: string };

class Refusal extends Error {
  constructor(
    readonly code: GuardCode,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/**
 * Replace the inside of every string literal so that words and symbols inside values are not mistaken for SQL.
 * A backslash and the character after it stay inside the literal, as a Spark-style engine reads them.
 */
export function blankLiterals(sql: string): string {
  return sql.replace(/'(?:[^'\\]|''|\\[\s\S])*'/g, (m) => `'${"x".repeat(Math.max(0, m.length - 2))}'`);
}

function reject(code: GuardCode, reason: string): GuardVerdict {
  return { ok: false, code, reason };
}

const isPunct = (t: Token | undefined, value: string): boolean => t?.kind === "punct" && t.value === value;

/**
 * A `*` is a wildcard (every column) right after SELECT, DISTINCT or ALL, after a comma in the select list, or after
 * `alias.`. After an opening bracket (`COUNT(*)`) or a value (`a * b`) it is not.
 */
const isWildcard = (before: Token | undefined): boolean =>
  (before?.kind === "word" && ["select", "distinct", "all"].includes(before.value)) ||
  isPunct(before, ",") ||
  isPunct(before, ".");
const isWord = (t: Token | undefined, value?: string): boolean =>
  t?.kind === "word" && (value === undefined || t.value === value);

/** Read a quoted run starting at `start` (the opening quote); a doubled quote stands for one. */
function readQuoted(text: string, start: number): { content: string; end: number } {
  const quote = text[start] as string;
  let content = "";
  let j = start + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        content += quote;
        j += 2;
        continue;
      }
      return { content, end: j + 1 };
    }
    content += text[j];
    j++;
  }
  throw new Refusal("unbalanced_quote", "a quote is not closed");
}

/** Split a statement into tokens. Outside string values only printable ASCII is accepted. */
function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const { token, end } = nextToken(text, i, tokens.at(-1));
    if (token) tokens.push(token);
    i = end;
  }
  return tokens;
}

function nextToken(text: string, i: number, prev: Token | undefined): { token?: Token; end: number } {
  const c = text[i] as string;
  if (c === " " || c === "\t" || c === "\n" || c === "\r") return { end: i + 1 };
  if (c === "'") {
    const { content, end } = readQuoted(text, i);
    return { token: { kind: "string", value: content }, end };
  }
  if (c === "`" || c === '"') return quotedName(text, i);
  if (/[A-Za-z_]/.test(c)) {
    const word = matchAt(WORD, text, i);
    return { token: { kind: "word", value: word.toLowerCase() }, end: i + word.length };
  }
  if (/\d/.test(c) || (c === "." && /\d/.test(text[i + 1] ?? "") && !endsOperand(prev))) return numberAt(text, i);
  if (PUNCTUATION.has(c)) return { token: { kind: "punct", value: c }, end: i + 1 };
  if (c.charCodeAt(0) > 0x7e) throw new Refusal("non_ascii", "only plain ASCII is allowed outside string values");
  throw new Refusal("forbidden_character", `the character "${c}" is not allowed outside string values`);
}

function quotedName(text: string, i: number): { token: Token; end: number } {
  const { content, end } = readQuoted(text, i);
  if (/[^\x20-\x7e]/.test(content)) {
    throw new Refusal("non_ascii", "a quoted name contains a character outside plain ASCII");
  }
  return { token: { kind: "quoted", value: content }, end };
}

function numberAt(text: string, i: number): { token: Token; end: number } {
  const number = matchAt(NUMBER, text, i);
  // A number that runs straight into a name ("1e5from", "1abc") can be read more than one way.
  if (/[A-Za-z0-9_]/.test(text[i + number.length] ?? "")) {
    throw new Refusal("unrecognised_table", "a number runs into a name; add a space");
  }
  return { token: { kind: "number", value: number }, end: i + number.length };
}

function endsOperand(t: Token | undefined): boolean {
  if (!t) return false;
  if (t.kind === "punct") return t.value === ")" || t.value === "]";
  return true;
}

const isName = (t: Token | undefined): boolean => t?.kind === "word" || t?.kind === "quoted";

/** A dotted table name of plain parts. A quoted part must itself be a plain name. */
function readName(tokens: readonly Token[], start: number): { name: string; next: number } {
  const parts: string[] = [];
  let j = start;
  for (;;) {
    const t = tokens[j];
    if (!isName(t)) {
      throw new Refusal("unrecognised_table", "a table must be named where FROM, JOIN or a comma expects one");
    }
    if (t?.kind === "quoted" && !PLAIN_NAME.test(t.value)) {
      throw new Refusal("unrecognised_table", "a quoted table name must be a plain name");
    }
    parts.push((t as Token).value.toLowerCase());
    j++;
    if (!isPunct(tokens[j], ".")) break;
    j++;
  }
  if (isPunct(tokens[j], "(")) throw new Refusal("unrecognised_table", "table functions are not allowed");
  return { name: parts.join("."), next: j };
}

/** An optional alias (with AS, or a name that is not a keyword that may follow a table); returns where it ends. */
function skipAlias(tokens: readonly Token[], start: number): { next: number; alias: boolean } {
  const t = tokens[start];
  if (isWord(t, "as")) {
    if (!isName(tokens[start + 1])) throw new Refusal("unrecognised_table", "AS needs an alias");
    return { next: start + 2, alias: true };
  }
  if (t?.kind === "quoted" || (t?.kind === "word" && !AFTER_RELATION.has(t.value))) {
    return { next: start + 1, alias: true };
  }
  return { next: start, alias: false };
}

/** A list of column names in brackets after an alias, as in `AS s(a, b)`; returns where it ends. */
function skipColumnAliases(tokens: readonly Token[], start: number): number {
  if (!isPunct(tokens[start], "(")) return start;
  let j = start + 1;
  for (;;) {
    if (!isName(tokens[j])) throw new Refusal("unrecognised_table", "bad column alias list");
    j++;
    if (isPunct(tokens[j], ")")) return j + 1;
    if (!isPunct(tokens[j], ",")) throw new Refusal("unrecognised_table", "bad column alias list");
    j++;
  }
}

/** After a table or a bracketed relation: an optional alias, then only what may follow it in a FROM list. */
function readAlias(tokens: readonly Token[], start: number, inFromList: boolean): number {
  const { next: afterAlias, alias } = skipAlias(tokens, start);
  const j = alias ? skipColumnAliases(tokens, afterAlias) : afterAlias;
  const next = tokens[j];
  if (next === undefined || isPunct(next, ")")) return j;
  if (isPunct(next, ",") && inFromList) return j;
  if (next.kind === "word" && AFTER_RELATION.has(next.value)) return j;
  throw new Refusal("unrecognised_table", "unexpected text after a table in the FROM list");
}

/** Whether a clause word at `i` ends the FROM list, or is a column that happens to share its name. */
function closesFromList(tokens: readonly Token[], i: number): boolean {
  const word = (tokens[i] as Token).value;
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  if (!prev || (prev.kind === "punct" && prev.value !== ")" && prev.value !== "]")) return false;
  if (prev.kind === "word" && EXPECTS_OPERAND.has(prev.value)) return false;
  const ambiguous =
    next === undefined || isPunct(next, ",") || isPunct(next, ")") || (BY_CLAUSES.has(word) && !isWord(next, "by"));
  if (ambiguous) throw new Refusal("unrecognised_table", `"${word}" cannot be told apart from a table alias here`);
  return true;
}

interface Frame {
  /** Inside a FROM list at this bracket depth: a comma starts another table. */
  fromList: boolean;
  /** This bracket was opened where a table was expected; an alias may follow its close. */
  relation: boolean;
}

/**
 * Reads every table the statement names, from every position a table can take. One pass over the tokens keeps
 * a stack of brackets; FROM, JOIN and a comma inside a FROM list mark the next token as a table position.
 */
class TableReader {
  readonly tables: string[] = [];
  sawFrom = false;
  private readonly stack: Frame[] = [{ fromList: false, relation: false }];
  private readonly relationAt = new Set<number>();

  constructor(private readonly tokens: readonly Token[]) {}

  read(): this {
    let i = 0;
    while (i < this.tokens.length) {
      i = this.relationAt.has(i) ? this.relation(i) : this.step(i);
    }
    if (this.stack.length !== 1) throw new Refusal("unbalanced_brackets", "brackets do not balance");
    if ([...this.relationAt].some((at) => at >= this.tokens.length)) {
      throw new Refusal("unrecognised_table", "FROM, JOIN or a comma is not followed by a table");
    }
    return this;
  }

  private get frame(): Frame {
    return this.stack.at(-1) as Frame;
  }

  /** A table position: a bracket (a subquery, or more tables) or a name with an optional alias. */
  private relation(i: number): number {
    if (isPunct(this.tokens[i], "(")) {
      const inner = this.tokens[i + 1];
      const query = inner?.kind === "word" && QUERY_START.has(inner.value);
      this.stack.push({ fromList: !query, relation: true });
      if (!query) this.relationAt.add(i + 1);
      return i + 1;
    }
    const { name, next } = readName(this.tokens, i);
    this.tables.push(name);
    return readAlias(this.tokens, next, this.frame.fromList);
  }

  private step(i: number): number {
    const t = this.tokens[i] as Token;
    if (t.kind === "word") this.word(t.value, i);
    else if (isPunct(t, ",") && this.frame.fromList) this.relationAt.add(i + 1);
    else if (isPunct(t, "(")) this.stack.push({ fromList: false, relation: false });
    else if (isPunct(t, ")")) return this.close(i);
    return i + 1;
  }

  private word(value: string, i: number): void {
    if (value === "from") {
      this.frame.fromList = true;
      this.sawFrom = true;
      this.relationAt.add(i + 1);
    } else if (value === "join") {
      if (!this.frame.fromList) throw new Refusal("unrecognised_table", "JOIN outside a FROM list");
      this.relationAt.add(i + 1);
    } else if (value === "using") {
      if (!isPunct(this.tokens[i + 1], "(")) {
        throw new Refusal("unrecognised_table", "USING must be followed by columns");
      }
    } else if (this.frame.fromList && CLAUSE_END.has(value) && closesFromList(this.tokens, i)) {
      this.frame.fromList = false;
    }
  }

  private close(i: number): number {
    const closed = this.stack.pop() as Frame;
    if (this.stack.length === 0) throw new Refusal("unbalanced_brackets", "brackets do not balance");
    return closed.relation ? readAlias(this.tokens, i + 1, this.frame.fromList) : i + 1;
  }
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
  // A Spark-style engine reads a backslash in a string as an escape; refusing it keeps the guard and the engine
  // in agreement about where every string ends.
  if (text.includes("\\")) return reject("backslash", "a backslash is not allowed in a statement");
  // Variable substitution rewrites the text before it is parsed, inside strings too.
  if (text.includes("${")) return reject("forbidden_character", "variable substitution is not allowed");
  return undefined;
}

function guardSelect(text: string, tokens: readonly Token[], options: GuardOptions): GuardVerdict {
  const words = tokens.flatMap((t) =>
    t.kind === "word" ? [t.value] : t.kind === "quoted" ? (t.value.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) : [],
  );
  const forbidden = words.find((word) => (FORBIDDEN_WORDS as readonly string[]).includes(word));
  if (forbidden) return reject("forbidden_keyword", `"${forbidden}" is not allowed in a read-only query`);
  const fn = tokens.find(
    (t, k) =>
      (t.kind === "word" || t.kind === "quoted") &&
      (FORBIDDEN_FUNCTIONS as readonly string[]).includes(t.value.toLowerCase()) &&
      isPunct(tokens[k + 1], "("),
  );
  if (fn) return reject("forbidden_function", `function "${fn.value.toLowerCase()}" is not allowed`);

  let found: { tables: string[]; sawFrom: boolean };
  try {
    found = new TableReader(tokens).read();
  } catch (err) {
    if (err instanceof Refusal) return reject(err.code, err.reason);
    throw err;
  }
  const { tables, sawFrom } = found;
  if (tables.length === 0) {
    return sawFrom
      ? reject("no_table", "a subquery must read an allowed table")
      : { ok: true, kind: "select", sql: text, tables: [] };
  }
  const allowed = new Set(options.allowedTables.map((t) => t.toLowerCase()));
  const outside = tables.find((table) => !allowed.has(table));
  if (outside) return reject("table_not_allowed", `table "${outside}" is not in the allowed list`);
  if (tokens.some((t, k) => isPunct(t, "*") && isWildcard(tokens[k - 1]))) {
    return reject(
      "select_star",
      "SELECT * is not allowed: name the columns, so a denied column is never read by accident",
    );
  }
  return { ok: true, kind: "select", sql: text, tables: [...new Set(tables)] };
}

export function guardSql(sql: string, options: GuardOptions): GuardVerdict {
  // Only ASCII spacing is trimmed; any other character at either end is judged like the rest of the text.
  const text = sql.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const refused = precheck(text, options.maxLength ?? DEFAULT_MAX_LENGTH);
  if (refused) return refused;

  let tokens: Token[];
  try {
    tokens = lex(text);
  } catch (err) {
    if (err instanceof Refusal) return reject(err.code, err.reason);
    throw err;
  }
  const first = tokens.find((t) => t.kind === "word")?.value;
  const model = `${options.namespace}.${options.usl}`.toLowerCase();

  if (first === "load")
    return guardMetadata(text, `load usl ${options.usl} namespace ${options.namespace}`.toLowerCase());
  if (first === "list") return guardMetadata(text, `list dq usl ${model}`);
  if (first === "show") return guardShow(text, options, model);
  if (first !== "select") return reject("not_read_only", "only SELECT, SHOW and USL metadata statements are allowed");
  return guardSelect(text, tokens, options);
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

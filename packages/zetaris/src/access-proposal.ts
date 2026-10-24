import { AppError } from "@sanctions-desk/shared";

/**
 * A mock for a proposed way to declare access control inside a semantic-layer definition (see
 * zetaris/proposals/). It reads the proposed statements and says, for each one, how it can be done on the
 * current platform: by SQL, by REST, or only in the interface. It sends nothing itself.
 */

export type ProposedStatement =
  | { kind: "create_role"; role: string; description: string }
  | { kind: "create_user"; user: string; role: string; scope: string; expiresDays: number }
  | { kind: "grant_all"; role: string }
  | { kind: "grant_table"; table: string; role: string }
  | { kind: "mask"; table: string; column: string; pattern: string; replacement: string; role: string }
  | { kind: "row_filter"; table: string; role: string; where: string };

/** How a statement can be carried out on the platform today. */
export type TodayChannel = "sql" | "rest" | "interface";

export interface PlanStep {
  statement: ProposedStatement;
  channel: TodayChannel;
  /** The statements or the manual step that carry it out. */
  today: string[];
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const RULES: { pattern: RegExp; build: (m: RegExpExecArray) => ProposedStatement }[] = [
  {
    pattern: new RegExp(`^CREATE ROLE (${IDENT}) DESCRIBE BY '([^']*)'$`, "i"),
    build: (m) => ({ kind: "create_role", role: m[1] as string, description: m[2] as string }),
  },
  {
    pattern: new RegExp(`^CREATE USER (${IDENT}) ROLE (${IDENT}) TOKEN SCOPE (${IDENT}) EXPIRES (\\d+) DAYS$`, "i"),
    build: (m) => ({
      kind: "create_user",
      user: m[1] as string,
      role: m[2] as string,
      scope: (m[3] as string).toLowerCase(),
      expiresDays: Number(m[4]),
    }),
  },
  {
    pattern: new RegExp(`^GRANT SELECT ON ALL TABLES TO ROLE (${IDENT})$`, "i"),
    build: (m) => ({ kind: "grant_all", role: m[1] as string }),
  },
  {
    pattern: new RegExp(`^GRANT SELECT ON TABLE (${IDENT}) TO ROLE (${IDENT})$`, "i"),
    build: (m) => ({ kind: "grant_table", table: m[1] as string, role: m[2] as string }),
  },
  {
    pattern: new RegExp(
      `^ALTER TABLE (${IDENT}) MASK COLUMN (${IDENT}) REGEX '([^']*)' REPLACE '([^']*)' FOR ROLE (${IDENT})$`,
      "i",
    ),
    build: (m) => ({
      kind: "mask",
      table: m[1] as string,
      column: m[2] as string,
      pattern: m[3] as string,
      replacement: m[4] as string,
      role: m[5] as string,
    }),
  },
  {
    pattern: new RegExp(`^ALTER TABLE (${IDENT}) ROW FILTER FOR ROLE (${IDENT}) WHERE (.+)$`, "i"),
    build: (m) => ({ kind: "row_filter", table: m[1] as string, role: m[2] as string, where: m[3] as string }),
  },
];

/** Split the file into statements (semicolon-terminated, `--` comments dropped) and read each one. */
export function parseProposal(text: string): ProposedStatement[] {
  const body = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join(" ");
  const out: ProposedStatement[] = [];
  for (const raw of body.split(";")) {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (sql === "") continue;
    const rule = RULES.map((r) => ({ r, m: r.pattern.exec(sql) })).find((x) => x.m !== null);
    if (!rule?.m) throw new AppError("validation", `not a statement of the proposal: ${sql.slice(0, 80)}`);
    out.push(rule.r.build(rule.m));
  }
  return out;
}

/** Apply a mask the way the proposal defines it: every match of the pattern is replaced. */
export function applyProposedMask(value: string, pattern: string, replacement: string): string {
  return value.replace(new RegExp(pattern, "gs"), replacement);
}

/** Keep only the rows a role may see under its row filters (equality filters only, as in the proposal). */
export function applyRowFilter(rows: readonly Record<string, string | null>[], where: string) {
  const m = /^(\w+)\s*=\s*'([^']*)'$/.exec(where.trim());
  if (!m) throw new AppError("validation", `the mock reads only equality filters: ${where}`);
  return rows.filter((r) => r[m[1] as string] === m[2]);
}

const FULL = (model: string, table: string) => `${model}.${table}`;

/** What it takes to do each statement today. `tables` are the model's table names. */
export function planFor(
  statements: readonly ProposedStatement[],
  model: string,
  tables: readonly string[],
): PlanStep[] {
  return statements.flatMap((s): PlanStep[] => {
    switch (s.kind) {
      case "create_role":
        return [{ statement: s, channel: "sql", today: [`CREATE ROLE '${s.role}' DESCRIBE BY '${s.description}'`] }];
      case "create_user":
        return [
          {
            statement: s,
            channel: "rest",
            today: [
              "POST /users (no SQL; random password kept in memory)",
              `ASSIGN USER '${s.user}' TO ROLE '${s.role}'`,
              `POST /auth/api-key (valid ${s.expiresDays} days; the scope ${s.scope} cannot be requested today)`,
            ],
          },
        ];
      case "grant_all":
        return [
          {
            statement: s,
            channel: "sql",
            today: tables.map((t) => `GRANT SELECT ON USL TABLE ${FULL(model, t)} TO ROLE '${s.role}'`),
          },
        ];
      case "grant_table":
        return [
          {
            statement: s,
            channel: "sql",
            today: [`GRANT SELECT ON USL TABLE ${FULL(model, s.table)} TO ROLE '${s.role}'`],
          },
        ];
      case "mask":
        return [
          {
            statement: s,
            channel: "interface",
            today: [
              `Column Access screen of ${s.table}: set ${s.column} to HIDE for ${s.role} (a pattern mask does not exist; HIDE hides the whole value)`,
            ],
          },
        ];
      case "row_filter":
        return [
          {
            statement: s,
            channel: "interface",
            today: [
              `No row filter on a model table exists today; ${s.role} would need a view on ${s.table} with ${s.where}`,
            ],
          },
        ];
      default:
        return [];
    }
  });
}

/** Steps that cannot be written as SQL today, so a script cannot repeat them after the model is rebuilt. */
export function stepsOutsideSql(plan: readonly PlanStep[]): number {
  return plan.filter((p) => p.channel !== "sql").length;
}

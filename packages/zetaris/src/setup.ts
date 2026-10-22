import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, type Config, type FetchLike, httpRequest, sha256Hex } from "@sanctions-desk/shared";

/**
 * One-time setup against Zetaris, with the admin key. This is deliberately separate from the runtime
 * client: it has no SQL guard (setup statements create things) and nothing in the application imports it.
 * Every statement lives in a reviewed file under zetaris/sql/ and is first listed (dry run), then applied.
 */

export interface SetupStatement {
  name: string;
  sql: string;
}

/** Split a script into statements. Each starts at a "-- @@ name" line; comment-only lines are dropped. */
export function parseStatements(script: string): SetupStatement[] {
  const out: SetupStatement[] = [];
  let current: { name: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const sql = current.lines
      .join("\n")
      .trim()
      .replace(/;+\s*$/, "")
      .trim();
    if (sql === "") throw new AppError("validation", `statement "${current.name}" is empty`);
    out.push({ name: current.name, sql });
  };
  for (const line of script.split("\n")) {
    const marker = /^--\s*@@\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (marker) {
      flush();
      current = { name: marker[1] as string, lines: [] };
    } else if (current && !/^\s*--/.test(line)) {
      current.lines.push(line);
    }
  }
  flush();
  const names = out.map((s) => s.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new AppError("validation", `statement name "${duplicate}" is used twice`);
  return out;
}

export function readStatements(path: string): SetupStatement[] {
  return parseStatements(readFileSync(path, "utf8"));
}

/** Replace ${NAME} with environment values. A missing value is an error; values are never logged. */
export function fillPlaceholders(
  sql: string,
  env: Record<string, string | undefined>,
): { sql: string; used: string[] } {
  const used: string[] = [];
  const filled = sql.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_m, name: string) => {
    const value = env[name];
    if (value === undefined || value === "")
      throw new AppError("config_missing", `environment value ${name} is not set`);
    used.push(name);
    return value;
  });
  return { sql: filled, used };
}

export type SetupOutcome = "applied" | "skipped_exists" | "failed" | "dry_run";

export interface SetupResult {
  name: string;
  outcome: SetupOutcome;
  latency_ms: number;
  rows?: number;
  /** The first rows of the answer, as JSON, for check scripts. */
  preview?: string;
  error?: string;
}

const EXISTS_PATTERN = /already exist|is existing|already been|already registered|duplicate/i;

export interface SetupRunOptions {
  config: Config;
  statements: readonly SetupStatement[];
  /** When false (the default) nothing is sent: the statements are only listed. */
  apply?: boolean;
  /** Treat "already exists" answers as skipped instead of failed, so a script can be run again. */
  skipExists?: boolean;
  env?: Record<string, string | undefined>;
  /** JSONL log of every statement and its outcome. */
  logFile?: string;
  fetchImpl?: FetchLike;
  onResult?: (result: SetupResult, sql: string) => void;
}

function errorMessage(text: string): string {
  try {
    const msg = (JSON.parse(text) as { msg?: unknown }).msg;
    if (typeof msg === "string") return msg.split("\n")[0]?.slice(0, 400) ?? text.slice(0, 400);
  } catch {
    // keep the raw text
  }
  return text.slice(0, 400);
}

function successResult(name: string, latency: number, text: string): SetupResult {
  try {
    const data = (JSON.parse(text) as { data?: unknown[] }).data ?? [];
    return {
      name,
      outcome: "applied",
      latency_ms: latency,
      rows: data.length,
      preview: JSON.stringify(data.slice(0, 5)).slice(0, 600),
    };
  } catch {
    return { name, outcome: "applied", latency_ms: latency, rows: 0 };
  }
}

async function applyStatement(options: SetupRunOptions, name: string, sql: string): Promise<SetupResult> {
  const z = options.config.zetaris;
  if (!z.apiKey) throw new AppError("config_missing", "the Zetaris admin key is required for setup");
  const queryId = crypto.randomUUID();
  const response = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${z.apiKey.reveal()}`, "X-Org-ID": z.orgId, "X-Request-ID": queryId },
    body: { queryId, sql, source: "SqlEditor", limit: 50 },
    timeoutMs: z.requestTimeoutMs * 4,
    fetchImpl: options.fetchImpl,
  });
  const latency = Math.round(response.ms);
  if (response.status === 200) return successResult(name, latency, response.text);
  const exists = options.skipExists === true && EXISTS_PATTERN.test(response.text);
  return {
    name,
    outcome: exists ? "skipped_exists" : "failed",
    latency_ms: latency,
    error: errorMessage(response.text),
  };
}

export async function runSetup(options: SetupRunOptions): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  if (options.logFile) mkdirSync(dirname(options.logFile), { recursive: true });
  const log = (entry: Record<string, unknown>) => {
    if (options.logFile)
      appendFileSync(options.logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };

  for (const statement of options.statements) {
    const filled = fillPlaceholders(statement.sql, options.env ?? process.env);
    const result = options.apply
      ? await applyStatement(options, statement.name, filled.sql)
      : ({ name: statement.name, outcome: "dry_run", latency_ms: 0 } satisfies SetupResult);
    log({
      ...result,
      mode: options.apply ? "apply" : "dry_run",
      sql_hash: sha256Hex(statement.sql),
      sql: statement.sql,
      placeholders: filled.used,
    });
    results.push(result);
    options.onResult?.(result, statement.sql);
    if (result.outcome === "failed") break;
  }
  return results;
}

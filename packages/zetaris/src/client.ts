import { randomUUID } from "node:crypto";
import { AppError, type Config, type FetchLike, httpRequest, sha256Hex } from "@sanctions-desk/shared";
import { type GuardCode, guardSql, type StatementKind } from "./guard.js";

/**
 * The only way the application reads data. Every call:
 *   - runs the SQL guard,
 *   - uses the API token of the caller's role (the admin key is a labelled fallback, never the default),
 *   - has a hard timeout,
 *   - produces a query record (id, SQL, row count, latency) for the trace.
 */

export const ZETARIS_ROLES = ["evidence", "reviewer", "eval"] as const;
export type ZetarisRole = (typeof ZETARIS_ROLES)[number];

export type TokenSource = "role" | "fallback";

export interface QueryRecord {
  query_id: string;
  role: ZetarisRole;
  token_source: TokenSource;
  kind: StatementKind;
  sql: string;
  sql_hash: string;
  tables: string[];
  status: "ok" | "error" | "blocked";
  row_count: number;
  latency_ms: number;
  cache_hit: boolean;
  error?: string;
  blocked_by?: GuardCode;
}

export interface QueryResult extends QueryRecord {
  headers: string[];
  rows: Array<Array<string | null>>;
  /** Rows as objects keyed by column name. Every value is a string, or null for SQL NULL, exactly as Zetaris returns it. */
  objects: Array<Record<string, string | null>>;
}

export interface ZetarisClientOptions {
  config: Config;
  fetchImpl?: FetchLike;
  /** Called for every query, successful or not. Used to write trace events. */
  onQuery?: (record: QueryRecord) => void;
  /** For replaying saved answers: no token is needed because nothing leaves the process. */
  offline?: boolean;
}

/** What one agent may read: its tables, and columns it must never name. Enforced here, whatever the credential. */
export interface AgentScope {
  agent: string;
  tables: readonly string[];
  denyColumns: readonly string[];
}

export interface ZetarisClient {
  query(role: ZetarisRole, sql: string, signal?: AbortSignal): Promise<QueryResult>;
  /** The same client, limited to one agent's tables and columns by our own guard. */
  scoped(scope: AgentScope): ZetarisClient;
  /** Replace the list of tables the guard allows (taken from the semantic layer's own metadata). */
  setAllowedTables(tables: readonly string[]): void;
  allowedTables(): string[];
  /** Which token a role would use right now, without revealing it. */
  tokenSource(role: ZetarisRole): TokenSource | "missing";
}

interface RunResponse {
  headers: string[];
  data: unknown[][];
  total: number;
}

function parseRunResponse(text: string): RunResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError("bad_response", "Zetaris returned a response that is not JSON", { recoverable: true });
  }
  const obj = json as Partial<RunResponse>;
  if (!Array.isArray(obj.headers) || !Array.isArray(obj.data)) {
    throw new AppError("bad_response", "Zetaris response has no headers or data", { recoverable: true });
  }
  return {
    headers: obj.headers.map(String),
    data: obj.data as unknown[][],
    total: Number(obj.total ?? obj.data.length),
  };
}

function messageOf(text: string): string {
  try {
    const msg = (JSON.parse(text) as { msg?: unknown }).msg;
    return typeof msg === "string" ? (msg.split("\n")[0]?.slice(0, 300) ?? "query failed") : "query failed";
  } catch {
    return "query failed";
  }
}

/** The platform's wording when a signed-in user lacks a permission. */
const ACCESS_DENIED = /does not have access|not permitted|permission denied/i;

export function createZetarisClient(options: ZetarisClientOptions): ZetarisClient {
  const { config } = options;
  const z = config.zetaris;
  let allowed: string[] = [];

  const tokenFor = (role: ZetarisRole): { token: string; source: TokenSource } | undefined => {
    const own = refused.has(role) ? undefined : z.tokens[role];
    if (own) return { token: own.reveal(), source: "role" };
    if (z.apiKey) return { token: z.apiKey.reveal(), source: "fallback" };
    if (options.offline) return { token: "offline", source: "role" };
    return undefined;
  };

  const refused = new Set<ZetarisRole>();

  type Verdict = Extract<ReturnType<typeof guardSql>, { ok: true }>;
  type Sent = { ok: true; result: QueryResult } | { ok: false; denied: boolean; error: AppError };

  /** One request to Zetaris with the given credential; every outcome is reported through `onQuery`. */
  async function send(
    role: ZetarisRole,
    verdict: Verdict,
    credential: { token: string; source: TokenSource },
    signal?: AbortSignal,
  ): Promise<Sent> {
    const queryId = randomUUID();
    const base = {
      query_id: queryId,
      role,
      sql: verdict.sql,
      sql_hash: sha256Hex(verdict.sql),
      cache_hit: options.offline === true,
    };
    const record = { ...base, token_source: credential.source, kind: verdict.kind, tables: verdict.tables };
    let result: { status: number; text: string; ms: number };
    try {
      result = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "X-Org-ID": z.orgId, "X-Request-ID": queryId },
        body: { queryId, sql: verdict.sql, source: "SqlEditor", limit: z.maxRows },
        timeoutMs: z.requestTimeoutMs,
        signal,
        fetchImpl: options.fetchImpl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.onQuery?.({ ...record, status: "error", row_count: 0, latency_ms: 0, error: message });
      throw err;
    }
    const latency = Math.round(result.ms);
    if (result.status !== 200) {
      const message = messageOf(result.text);
      options.onQuery?.({ ...record, status: "error", row_count: 0, latency_ms: latency, error: message });
      const denied = result.status === 401 || result.status === 403 || ACCESS_DENIED.test(message);
      return {
        ok: false,
        denied,
        error: new AppError("query_failed", `Zetaris rejected the query (HTTP ${result.status}): ${message}`, {
          recoverable: !denied && result.status >= 500,
          details: { status: result.status, query_id: queryId },
        }),
      };
    }
    const parsed = parseRunResponse(result.text);
    const rows = parsed.data.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))));
    const objects = rows.map((r) => Object.fromEntries(parsed.headers.map((h, i) => [h, r[i] ?? null])));
    const final: QueryRecord = { ...record, status: "ok", row_count: rows.length, latency_ms: latency };
    options.onQuery?.(final);
    return { ok: true, result: { ...final, headers: parsed.headers, rows, objects } };
  }

  async function run(scope: AgentScope | undefined, role: ZetarisRole, sql: string, signal?: AbortSignal) {
    {
      const queryId = randomUUID();
      // Offline means the answer is replayed from saved real queries, which the record says plainly.
      const base = { query_id: queryId, role, sql, sql_hash: sha256Hex(sql), cache_hit: options.offline === true };
      const verdict = guardSql(sql, { allowedTables: allowed, namespace: z.namespace, usl: z.usl });
      if (!verdict.ok) {
        options.onQuery?.({
          ...base,
          token_source: tokenFor(role)?.source ?? "fallback",
          kind: "select",
          tables: [],
          status: "blocked",
          row_count: 0,
          latency_ms: 0,
          error: verdict.reason,
          blocked_by: verdict.code,
        });
        throw new AppError("guard_blocked", `query blocked: ${verdict.reason}`, { details: { code: verdict.code } });
      }
      const outside = scope ? scopeViolation(scope, verdict.tables, verdict.sql) : undefined;
      if (outside) {
        options.onQuery?.({
          ...base,
          token_source: tokenFor(role)?.source ?? "fallback",
          kind: verdict.kind,
          tables: verdict.tables,
          status: "blocked",
          row_count: 0,
          latency_ms: 0,
          error: outside,
          blocked_by: "agent_scope",
        });
        throw new AppError("guard_blocked", `query blocked: ${outside}`, { details: { code: "agent_scope" } });
      }
      const credential = tokenFor(role);
      if (!credential) {
        throw new AppError("config_missing", `no Zetaris token is set for the ${role} identity`, { recoverable: true });
      }
      const first = await send(role, verdict, credential, signal);
      if (first.ok) return first.result;
      // A role token the platform refuses (its permissions are not in place yet) falls back to the admin key once,
      // visibly: the failed attempt is recorded under the role, the retry under "fallback", and the role is not
      // tried again. The SQL guard above has already limited what the retry can read.
      if (first.denied && credential.source === "role" && z.apiKey && z.fallbackOnDenied) {
        refused.add(role);
        const retry = await send(role, verdict, { token: z.apiKey.reveal(), source: "fallback" }, signal);
        if (retry.ok) return retry.result;
        throw retry.error;
      }
      throw first.error;
    }
  }

  const api: ZetarisClient = {
    setAllowedTables: (tables) => {
      allowed = [...new Set(tables.map((t) => t.toLowerCase()))];
    },
    allowedTables: () => [...allowed],
    tokenSource: (role) => tokenFor(role)?.source ?? "missing",
    query: (role, sql, signal) => run(undefined, role, sql, signal),
    scoped: (scope) => ({ ...api, query: (role, sql, signal) => run(scope, role, sql, signal), scoped: api.scoped }),
  };
  return api;
}

/** Why a statement is outside an agent's scope, or undefined when it is inside. */
export function scopeViolation(scope: AgentScope, tables: readonly string[], sql: string): string | undefined {
  const allowed = new Set(scope.tables.map((t) => t.toLowerCase()));
  const outside = tables.map((t) => t.split(".").pop() ?? t).filter((t) => !allowed.has(t.toLowerCase()));
  if (outside.length > 0) return `the ${scope.agent} step may not read ${[...new Set(outside)].join(", ")}`;
  const words = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
  const denied = scope.denyColumns.find((c) => words.has(c.toLowerCase()));
  if (denied) return `the ${scope.agent} step may not name the column ${denied}`;
  return undefined;
}

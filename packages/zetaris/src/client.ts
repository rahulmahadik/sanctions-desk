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

/** Policy role names (policy.masking) and the identities that serve them. */
export const POLICY_ROLE_TO_IDENTITY: Readonly<Record<string, ZetarisRole>> = {
  role_evidence_agent: "evidence",
  role_reviewer: "reviewer",
  role_eval: "eval",
};

export function identityOfPolicyRole(role: string): ZetarisRole {
  const identity = POLICY_ROLE_TO_IDENTITY[role];
  if (!identity) throw new AppError("validation", `unknown access role "${role}"`);
  return identity;
}

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

export interface ZetarisClient {
  query(role: ZetarisRole, sql: string, signal?: AbortSignal): Promise<QueryResult>;
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

export function createZetarisClient(options: ZetarisClientOptions): ZetarisClient {
  const { config } = options;
  const z = config.zetaris;
  let allowed: string[] = [];

  const tokenFor = (role: ZetarisRole): { token: string; source: TokenSource } | undefined => {
    const own = z.tokens[role];
    if (own) return { token: own.reveal(), source: "role" };
    if (z.apiKey) return { token: z.apiKey.reveal(), source: "fallback" };
    if (options.offline) return { token: "offline", source: "role" };
    return undefined;
  };

  return {
    setAllowedTables: (tables) => {
      allowed = [...new Set(tables.map((t) => t.toLowerCase()))];
    },
    allowedTables: () => [...allowed],
    tokenSource: (role) => tokenFor(role)?.source ?? "missing",

    async query(role, sql, signal) {
      const queryId = randomUUID();
      const base = { query_id: queryId, role, sql, sql_hash: sha256Hex(sql), cache_hit: false };
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
      const credential = tokenFor(role);
      if (!credential) {
        throw new AppError("config_missing", `no Zetaris token is set for the ${role} identity`, { recoverable: true });
      }
      const record = { ...base, token_source: credential.source, kind: verdict.kind, tables: verdict.tables };

      let result: { status: number; text: string; ms: number };
      try {
        result = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "X-Org-ID": z.orgId,
            "X-Request-ID": queryId,
          },
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
        const denied = result.status === 401 || result.status === 403;
        throw new AppError("query_failed", `Zetaris rejected the query (HTTP ${result.status}): ${message}`, {
          recoverable: !denied && result.status >= 500,
          details: { status: result.status, query_id: queryId },
        });
      }
      const parsed = parseRunResponse(result.text);
      const rows = parsed.data.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))));
      const objects = rows.map((r) => Object.fromEntries(parsed.headers.map((h, i) => [h, r[i] ?? null])));
      const final: QueryRecord = { ...record, status: "ok", row_count: rows.length, latency_ms: latency };
      options.onQuery?.(final);
      return { ...final, headers: parsed.headers, rows, objects };
    },
  };
}

import { AppError, type Config, type FetchLike, httpRequest, sha256Hex } from "@sanctions-desk/shared";
import { z } from "zod";
import type { ZetarisRole } from "./client.js";

/**
 * Zetaris keeps a history of the statements it ran (the SQL editor history): the query id, the statement, whether
 * it succeeded and when. Every query this application sends carries its own id, so each piece of evidence can be
 * matched to the platform's own record of that statement, independently of our trace.
 */

const EntrySchema = z.object({
  id: z.string(),
  sql: z.string(),
  status: z.string(),
  time: z.string(),
});
export type AuditEntry = z.infer<typeof EntrySchema>;

export interface AuditLookup {
  query_id: string;
  sql_hash: string;
  /** The statement as kept. Needed only for a redacted one. */
  sql?: string;
  /** The kept statement has a value replaced by a marker, so its hash cannot equal the hash of what Zetaris ran. */
  redacted?: boolean;
}

/**
 * `matched_redacted`: the statement Zetaris ran is the kept one with each marker filled by a single quoted value,
 * character for character elsewhere; the value itself (a document number) is not kept, so it is not compared.
 */
export type AuditStatus = "matched" | "matched_redacted" | "statement_differs" | "failed_at_source" | "not_in_history";

export interface AuditFinding {
  query_id: string;
  status: AuditStatus;
  zetaris_status?: string;
  zetaris_time?: string;
}

export interface AuditSummary {
  available: true;
  checked: number;
  matched: number;
  problems: number;
  findings: AuditFinding[];
}

/** Read the history of statements. The platform returns the whole list; the lookup is done here. */
export async function fetchQueryHistory(
  config: Config,
  token: string,
  fetchImpl?: FetchLike,
): Promise<Map<string, AuditEntry>> {
  const zetaris = config.zetaris;
  const response = await httpRequest(`${zetaris.restUrl}/sql-editor/sqls/history`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Org-ID": zetaris.orgId },
    timeoutMs: zetaris.requestTimeoutMs,
    fetchImpl,
  });
  if (response.status !== 200) {
    throw new AppError("query_failed", `Zetaris refused the query history (HTTP ${response.status})`, {
      recoverable: false,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new AppError("bad_response", "the query history is not JSON", { recoverable: true });
  }
  const entries = z.array(EntrySchema).safeParse(json);
  if (!entries.success)
    throw new AppError("bad_response", "the query history has an unexpected shape", { recoverable: true });
  return new Map(entries.data.map((e) => [e.id, e]));
}

const MARKER = /'<document number, sha256 [0-9a-f]+>'/g;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the statement Zetaris ran equal the kept one, with each marker standing for one quoted value? */
function sameButRedacted(kept: string, ran: string): boolean {
  const parts = kept.split(MARKER).map(escapeRegExp);
  if (parts.length < 2) return false;
  return new RegExp(`^${parts.join("'[^']*'")}$`).test(ran);
}

/** Match our queries against the platform's history. */
export function matchAudit(lookups: readonly AuditLookup[], history: ReadonlyMap<string, AuditEntry>): AuditSummary {
  const findings: AuditFinding[] = lookups.map((q) => {
    const entry = history.get(q.query_id);
    if (!entry) return { query_id: q.query_id, status: "not_in_history" };
    const base = { query_id: q.query_id, zetaris_status: entry.status, zetaris_time: entry.time };
    const redactedMatch = q.redacted === true && q.sql !== undefined && sameButRedacted(q.sql, entry.sql);
    if (!redactedMatch && sha256Hex(entry.sql) !== q.sql_hash) return { ...base, status: "statement_differs" };
    if (entry.status.toLowerCase() !== "success") return { ...base, status: "failed_at_source" };
    return { ...base, status: redactedMatch ? "matched_redacted" : "matched" };
  });
  const matched = findings.filter((f) => f.status === "matched" || f.status === "matched_redacted").length;
  return { available: true, checked: findings.length, matched, problems: findings.length - matched, findings };
}

/** The token used to read the history: the reviewer's own, else the labelled fallback. Never printed. */
export function auditToken(config: Config, role: ZetarisRole = "reviewer"): string | undefined {
  return (config.zetaris.tokens[role] ?? config.zetaris.apiKey)?.reveal();
}

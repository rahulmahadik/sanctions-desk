import { randomUUID } from "node:crypto";
import { type Config, type FetchLike, httpRequest } from "@sanctions-desk/shared";
import type { ZetarisRole } from "./client.js";

/**
 * Do the runtime identities really have access to the model? Zetaris keeps that in its interface (the View
 * permission on the Unified Semantic Layer, the namespace and model Access Control, and column access), with no SQL
 * or REST call to read it, and rebuilding the model empties it. So the only reliable check is to ask: each identity
 * runs one read on the model with its own token.
 */

export interface AccessResult {
  role: ZetarisRole;
  state: "ok" | "refused" | "no_token" | "unreachable";
  detail?: string;
}

export const ACCESS_FIX_STEPS = [
  "Management > Permissions: give ROLE_EVIDENCE_AGENT, ROLE_REVIEWER and ROLE_EVAL the View permission on Unified Semantic Layer.",
  "Data Product > Unified Semantic Layer > the namespace (sanctions): Access Control, assign the three roles.",
  "The model (screening_usl): Access Control, assign the three roles and tick SELECT on every table. Rebuilding the model creates a new model id and empties this list, so repeat it after every rebuild.",
  "customer_identifier > Column Access: HIDE id_number for ROLE_EVIDENCE_AGENT only.",
];

export async function checkRoleAccess(
  config: Config,
  options: { fetchImpl?: FetchLike } = {},
): Promise<AccessResult[]> {
  const z = config.zetaris;
  const table = `${z.namespace}.${z.usl}.customer`;
  const identities: Array<[ZetarisRole, typeof z.tokens.evidence]> = [
    ["evidence", z.tokens.evidence],
    ["reviewer", z.tokens.reviewer],
    ["eval", z.tokens.eval],
  ];
  const results: AccessResult[] = [];
  for (const [role, token] of identities) {
    if (!token) {
      results.push({ role, state: "no_token" });
      continue;
    }
    try {
      const res = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.reveal()}`, "X-Org-ID": z.orgId },
        body: { queryId: randomUUID(), sql: `SELECT COUNT(*) FROM ${table}`, source: "SqlEditor", limit: 1 },
        timeoutMs: z.requestTimeoutMs,
        fetchImpl: options.fetchImpl,
      });
      if (res.status === 200) {
        results.push({ role, state: "ok" });
        continue;
      }
      let msg = "";
      try {
        msg = String((JSON.parse(res.text) as { msg?: unknown }).msg ?? "");
      } catch {
        // not a JSON message
      }
      results.push({ role, state: "refused", detail: msg.split("\n")[0]?.slice(0, 160) || `HTTP ${res.status}` });
    } catch (err) {
      results.push({ role, state: "unreachable", detail: err instanceof Error ? err.message.slice(0, 120) : "failed" });
    }
  }
  return results;
}

/** A multi-line explanation for a log or a terminal, naming what failed and the exact steps that fix it. */
export function describeAccessFailure(results: readonly AccessResult[]): string {
  const bad = results.filter((r) => r.state !== "ok");
  return [
    `Role access to the semantic layer is not in place for: ${bad.map((r) => `${r.role} (${r.state}${r.detail ? `: ${r.detail}` : ""})`).join("; ")}.`,
    "Set it in the Zetaris interface:",
    ...ACCESS_FIX_STEPS.map((s, i) => `  ${i + 1}. ${s}`),
    "Then check again with `npm run check:roles`. See docs/ZETARIS.md.",
  ].join("\n");
}

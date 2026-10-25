import { randomUUID } from "node:crypto";
import { type Config, type FetchLike, httpRequest } from "@sanctions-desk/shared";
import type { ZetarisRole } from "./client.js";
import { USL_STEP_ROLES } from "./usl-spec.js";

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
  /** A per-step identity: optional, so no token is not a failure (the step then reads as evidence). */
  optional?: boolean;
}

/** The token setting of each per-step identity (see USL_STEP_ROLES) mapped to its role. */
const STEP_TOKEN: Record<string, ZetarisRole> = {
  ZETARIS_TOKEN_OWNERSHIP: "ownership",
  ZETARIS_TOKEN_CRITIC: "critic",
  ZETARIS_TOKEN_MEMORY: "memory",
  ZETARIS_TOKEN_DOCUMENT: "document",
  ZETARIS_TOKEN_RESCREEN: "rescreen",
};

/** Whether a check result stops a start or fails `npm run check:roles`: a refusal always; no token only for the main three. */
export const accessFails = (r: AccessResult): boolean => r.state !== "ok" && !(r.optional && r.state === "no_token");

export const ACCESS_FIX_STEPS = [
  "Management > Permissions: give ROLE_EVIDENCE_AGENT, ROLE_REVIEWER and ROLE_EVAL the View permission on Unified Semantic Layer.",
  "Data Product > Unified Semantic Layer > the namespace (sanctions): Access Control, assign the three roles.",
  "The model (screening_usl): Access Control, assign the three roles and tick SELECT on every table. Rebuilding the model creates a new model id and empties this list, so repeat it after every rebuild.",
  "customer_identifier > Column Access: HIDE id_number for ROLE_EVIDENCE_AGENT only.",
  "For a per-step role that is refused: run `npm run zetaris:agents -- --steps` and grant it its tables (docs/ZETARIS.md, roles and identities).",
];

export async function checkRoleAccess(
  config: Config,
  options: { fetchImpl?: FetchLike } = {},
): Promise<AccessResult[]> {
  const z = config.zetaris;
  const table = `${z.namespace}.${z.usl}.customer`;
  const identities: Array<[ZetarisRole, typeof z.tokens.evidence, string, boolean]> = [
    ["evidence", z.tokens.evidence, table, false],
    ["reviewer", z.tokens.reviewer, table, false],
    ["eval", z.tokens.eval, table, false],
    // Each per-step identity reads one table it was granted (its role has no access to customer).
    ...USL_STEP_ROLES.map((s): [ZetarisRole, typeof z.tokens.evidence, string, boolean] => {
      const role = STEP_TOKEN[s.tokenEnv] as ZetarisRole;
      return [role, z.tokens[role as keyof typeof z.tokens], `${z.namespace}.${z.usl}.${s.tables[0]}`, true];
    }),
  ];
  const results: AccessResult[] = [];
  for (const [role, token, from, optional] of identities) {
    const tag = optional ? { optional: true } : {};
    if (!token) {
      results.push({ role, state: "no_token", ...tag });
      continue;
    }
    try {
      const res = await httpRequest(`${z.restUrl}/sql-editor/sqls/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.reveal()}`, "X-Org-ID": z.orgId },
        body: { queryId: randomUUID(), sql: `SELECT COUNT(*) FROM ${from}`, source: "SqlEditor", limit: 1 },
        timeoutMs: z.requestTimeoutMs,
        fetchImpl: options.fetchImpl,
      });
      if (res.status === 200) {
        results.push({ role, state: "ok", ...tag });
        continue;
      }
      let msg = "";
      try {
        msg = String((JSON.parse(res.text) as { msg?: unknown }).msg ?? "");
      } catch {
        // not a JSON message
      }
      results.push({
        role,
        state: "refused",
        detail: msg.split("\n")[0]?.slice(0, 160) || `HTTP ${res.status}`,
        ...tag,
      });
    } catch (err) {
      results.push({
        role,
        state: "unreachable",
        detail: err instanceof Error ? err.message.slice(0, 120) : "failed",
        ...tag,
      });
    }
  }
  return results;
}

/** A multi-line explanation for a log or a terminal, naming what failed and the exact steps that fix it. */
export function describeAccessFailure(results: readonly AccessResult[]): string {
  const bad = results.filter(accessFails);
  return [
    `Role access to the semantic layer is not in place for: ${bad.map((r) => `${r.role} (${r.state}${r.detail ? `: ${r.detail}` : ""})`).join("; ")}.`,
    "Set it in the Zetaris interface:",
    ...ACCESS_FIX_STEPS.map((s, i) => `  ${i + 1}. ${s}`),
    "Then check again with `npm run check:roles`. See docs/ZETARIS.md.",
  ].join("\n");
}

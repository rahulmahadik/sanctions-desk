import {
  type CustomerProfile,
  compareParty,
  type ListedParty,
  type OwnershipStatus,
  type PartyComparison,
} from "@sanctions-desk/data";
import { type OwnershipResult, type OwnershipRow, OwnershipWorld } from "@sanctions-desk/engines";
import type { QueryEvidenceInput } from "@sanctions-desk/shared";
import { quoteLiteral, type UslModel } from "@sanctions-desk/zetaris";
import type { DqFinding, EvidenceBundle } from "./evidence.js";
import type { MatchResult } from "./matching.js";
import { type AgentDeps, clientFor, type Row } from "./types.js";

/**
 * The Ownership step: whether listed or blocked parties own the customer at or above the policy threshold (the
 * 50 percent rule, counted as a cascade). The register is read level by level through Zetaris into the World Model;
 * all the arithmetic is the ownership engine's.
 */

export interface OwnershipEvidence {
  result: OwnershipResult;
  /** The register rows that were read, as they came from Zetaris. */
  rows: Row[];
  status: OwnershipStatus;
}

const COLUMNS = [
  "ownership_id",
  "owned_party_id",
  "owned_party_kind",
  "owner_party_id",
  "owner_party_kind",
  "owner_name",
  "ownership_pct",
  "as_of",
] as const;

const asOwnershipRow = (r: Row): OwnershipRow => ({
  ownership_id: r.ownership_id ?? "",
  owned_party_id: r.owned_party_id ?? "",
  owner_party_id: r.owner_party_id ?? "",
  owner_party_kind: (r.owner_party_kind ?? "external") as OwnershipRow["owner_party_kind"],
  owner_name: r.owner_name ?? "",
  ownership_pct: r.ownership_pct === null || r.ownership_pct === "" ? null : (r.ownership_pct ?? null),
  as_of: r.as_of ?? "",
});

function statusOf(result: OwnershipResult): OwnershipStatus {
  if (result.outcome === "meets_threshold") return "met";
  if (result.outcome === "needs_review") return result.depthLimitReached ? "limit" : "unknown";
  return "below";
}

/** Read the register one level at a time, from the customer upwards, as far as the policy allows plus one level. */
export async function gatherOwnership(
  deps: AgentDeps,
  model: UslModel,
  customerId: string,
  queries: QueryEvidenceInput[],
): Promise<OwnershipEvidence> {
  const table = model.tables.find((t) => t.name === "beneficial_owner");
  if (!table) throw new Error("the semantic layer has no beneficial_owner table");
  const role = deps.policy.masking.evidence;
  const rows: Row[] = [];
  const seen = new Set<string>([customerId]);
  let frontier = [customerId];

  for (let level = 0; level <= deps.policy.ownership.maxChainDepth && frontier.length > 0; level += 1) {
    const list = frontier.map(quoteLiteral).join(", ");
    const sql = `SELECT ${COLUMNS.map((c) => `\`${c}\``).join(", ")} FROM ${table.qualifiedName} WHERE \`owned_party_id\` IN (${list}) ORDER BY \`ownership_id\``;
    const result = await clientFor(deps, "ownership").query("ownership", sql);
    deps.trace.log({
      agent: "ownership",
      action: "read_register",
      status: "ok",
      input_summary: `level ${level + 1}: ${frontier.length} parties`,
      output_summary: `${result.rows.length} ownership rows`,
      zetaris_query_id: result.query_id,
      latency_ms: result.latency_ms,
    });
    queries.push({
      query_id: result.query_id,
      agent: "ownership",
      role,
      table: table.qualifiedName,
      sql: result.sql,
      sql_hash: result.sql_hash,
      row_count: result.rows.length,
      row_hashes: [],
      masked_columns: [],
      token_source: result.token_source,
      latency_ms: result.latency_ms,
      cache_hit: result.cache_hit,
    });
    rows.push(...result.objects);
    frontier = result.objects
      .map((r) => r.owner_party_id ?? "")
      .filter(
        (id, i, all) =>
          id !== "" && all.indexOf(id) === i && !seen.has(id) && result.objects[i]?.owner_party_kind !== "listed",
      );
    for (const id of frontier) seen.add(id);
  }

  const world = new OwnershipWorld(`ownership:${customerId}`);
  await world.load(rows.map(asOwnershipRow));
  const result = world.evaluate(customerId, {
    thresholdPercent: deps.policy.ownership.thresholdPercent,
    aggregate: deps.policy.ownership.aggregate,
    maxChainDepth: deps.policy.ownership.maxChainDepth,
  });
  const status = statusOf(result);
  deps.trace.log({
    agent: "ownership",
    action: "evaluate",
    status: status === "met" ? "blocked" : "ok",
    output_summary: `${result.outcome}: ${result.reasons.join("; ") || "no listed owner reaches the threshold"}`,
    detail: {
      owners: result.owners.map((o) => ({ owner: o.ownerId, percent: o.effectivePercent, status: o.status })),
      cascade: result.cascade,
      blocked: result.blockedEntities,
      loops: result.loops.length,
      depth_limit: result.depthLimitReached,
      world_model: { rows: world.rows().length, audit_events: world.auditLength() },
    },
  });
  return { result, rows, status };
}

/** Does any register row in the customer's ownership chain fail a data-quality rule (for example a missing percentage)? */
export async function ownershipQuality(
  deps: AgentDeps,
  model: UslModel,
  rows: readonly Row[],
  queries: QueryEvidenceInput[],
): Promise<DqFinding[]> {
  const table = model.tables.find((t) => t.name === "beneficial_owner");
  if (!table) return [];
  const inChain = new Set(rows.map((r) => r.ownership_id ?? ""));
  const findings: DqFinding[] = [];
  for (const rule of table.dqRules) {
    const result = await clientFor(deps, "ownership").query(
      "ownership",
      `SHOW DQ INVALID RECORD ${rule.name} TABLE ${table.qualifiedName}`,
    );
    const listed = result.objects.some((o) => inChain.has(o.ownership_id ?? ""));
    // A cut-off list cannot show that the chain passes: it counts as failing (fail closed).
    const cutOff = !listed && result.truncated;
    const failed = listed || cutOff;
    findings.push({ table: table.name, rule: rule.name, failed, ...(cutOff ? { cutOff: true as const } : {}) });
    deps.trace.log({
      agent: "ownership",
      action: "data_quality",
      status: failed ? "blocked" : "ok",
      input_summary: `${table.name}.${rule.name}`,
      output_summary: failed
        ? "a register row in the chain fails this rule"
        : "no register row in the chain fails this rule",
      zetaris_query_id: result.query_id,
      latency_ms: result.latency_ms,
    });
    queries.push({
      query_id: result.query_id,
      agent: "ownership",
      role: deps.policy.masking.evidence,
      table: table.qualifiedName,
      sql: result.sql,
      sql_hash: result.sql_hash,
      row_count: result.rows.length,
      row_hashes: [],
      masked_columns: [],
      token_source: result.token_source,
      latency_ms: result.latency_ms,
      cache_hit: result.cache_hit,
    });
  }
  return findings;
}

/**
 * The comparison for an ownership alert. The alert is about a listed party on the customer's ownership register:
 * the register's name for the owner is compared with the listed name, and the approved ownership definition,
 * applied by the engine, decides how strong the case is.
 */
export function matchOwnership(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  ownership: OwnershipEvidence,
  party: ListedParty,
): MatchResult {
  const entryId = evidence.entry.entry_id ?? "";
  const register = ownership.rows.find((r) => r.owner_party_id === entryId);
  const customer: CustomerProfile = {
    customerId: evidence.customer.customer_id ?? "",
    kind: party.kind === "individual" ? "individual" : "company",
    name: register?.owner_name ?? party.primaryName,
    otherNames: [],
    dateOfBirth: null,
    nationality: null,
    residence: null,
    identifiers: [],
  };
  const base = compareParty(customer, party, { nameSimilarity: deps.policy.matching.nameSimilarityThreshold });
  const assessment: PartyComparison["assessment"] =
    ownership.status === "met" ? "strong" : ownership.status === "below" ? "weak" : "possible";
  const comparison: PartyComparison = {
    ...base,
    subject: "ownership",
    assessment,
    definitions: { true_match: false, false_positive: false, counterparty_match: false, ownership: ownership.status },
    reasons: [`ownership: ${ownership.result.outcome}`, ...ownership.result.reasons, ...base.reasons.slice(0, 1)],
  };
  deps.trace.log({
    agent: "matching",
    action: "compare_ownership",
    status: "ok",
    output_summary: `${assessment}: ${comparison.reasons.join("; ")}`,
  });
  return { customer, party, comparison };
}

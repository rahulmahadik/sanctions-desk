import { PointerMemory, type RecalledMemory } from "@sanctions-desk/engines";
import {
  type Decision,
  hashRow,
  type MemoryPointer,
  type MemoryUseInput,
  policyRef,
  type QueryEvidenceInput,
} from "@sanctions-desk/shared";
import type { EvidenceTool } from "@sanctions-desk/zetaris";
import type { EvidenceBundle } from "./evidence.js";
import type { AgentDeps, Row } from "./types.js";

/**
 * The Memory step: earlier human decisions about this customer and this listed party, kept as pointers (the
 * table, the row key, a hash of the row when it was decided) and never as copies of personal data. Before an
 * earlier decision may count, the pointer is re-checked against the listed entry as it is now: a different hash
 * means the entry changed, the memory is stale, and the case has to be looked at again.
 */

export interface MemoryEvidence {
  recalled: RecalledMemory[];
  /** An earlier clearance whose pointer still matches: the entry has not changed since. */
  fresh: boolean;
  /** An earlier decision whose pointer no longer matches: the entry changed or was removed. */
  stale: boolean;
  uses: MemoryUseInput[];
  /** What each recalled memory says, by memory id, so a decision can cite it and the critic can check the citation. */
  details: Map<string, MemoryDetail>;
}

export interface MemoryDetail {
  decision: string;
  state: "fresh" | "stale" | "overridden";
  decided_by: string;
  reason: string;
  source: "bank_disposition" | "desk_decision";
}

const none = (): MemoryEvidence => ({ recalled: [], fresh: false, stale: false, uses: [], details: new Map() });

function memoryOf(deps: AgentDeps, evidence: EvidenceBundle, disposition: Row, table: string) {
  const entryId = disposition.entry_id ?? "";
  const pointer: MemoryPointer = {
    usl_table: table,
    row_key: { entry_id: entryId },
    content_hash: disposition.entry_content_hash ?? "",
    ...(disposition.list_snapshot_id ? { list_snapshot_id: disposition.list_snapshot_id } : {}),
    usl_model_version: evidence.model.version,
    captured_at: disposition.decided_at ?? "",
  };
  return {
    memory_id: `mem-${disposition.disposition_id}`,
    alert_type: "customer" as const,
    decision: (disposition.decision ?? "CLOSE_FALSE_POSITIVE") as Decision,
    reason_codes: (disposition.reason_codes ?? "UNSPECIFIED").split(","),
    pointers: [pointer],
    policy: policyRef(deps.policy),
    decision_record_hash: hashRow(disposition),
    created_at: disposition.decided_at ?? "",
  };
}

type Source = Map<string, { row: Row; desk: boolean }>;

/** True when `other` is an earlier, different decision than `mine`, so `mine` replaces it. */
const replaces = (mine: { row: Row }, other: { row: Row }): boolean =>
  (other.row.decided_at ?? "") < (mine.row.decided_at ?? "") &&
  (other.row.decision ?? "") !== (mine.row.decision ?? "");

/** A person's later decision beats an earlier one: the earlier memory stops influencing reviews, and the ledger says who and why. */
function supersedeEarlier(memory: PointerMemory, source: Source): void {
  const mine = [...source].filter(([, v]) => v.desk);
  for (const [id, m] of mine) {
    for (const [otherId, other] of source) {
      if (otherId === id || !replaces(m, other)) continue;
      try {
        memory.override({
          memoryId: otherId,
          actor: m.row.decided_by ?? "analyst",
          reason: m.row.reason ?? "a later decision on this desk",
        });
      } catch {
        // already overridden by an earlier pass
      }
    }
  }
}

function detailsOf(recalled: readonly RecalledMemory[], source: Source): Map<string, MemoryDetail> {
  const details = new Map<string, MemoryDetail>();
  for (const r of recalled) {
    const s = source.get(r.memory.memory_id);
    details.set(r.memory.memory_id, {
      decision: r.memory.decision,
      state: r.overridden ? "overridden" : r.usable ? "fresh" : "stale",
      decided_by: s?.row.decided_by ?? "bank record",
      reason: s?.row.reason ?? s?.row.reason_codes ?? "",
      source: s?.desk ? "desk_decision" : "bank_disposition",
    });
  }
  return details;
}

function queryEvidenceOf(deps: AgentDeps, found: Awaited<ReturnType<EvidenceTool["find"]>>): QueryEvidenceInput {
  return {
    query_id: found.query.query_id,
    agent: "memory",
    role: deps.policy.masking.evidence,
    table: found.table,
    sql: found.query.sql,
    sql_hash: found.query.sql_hash,
    row_count: found.rows.length,
    row_hashes: found.rowHashes,
    masked_columns: found.maskedColumns,
    token_source: found.query.token_source,
    latency_ms: found.query.latency_ms,
    cache_hit: found.query.cache_hit,
  };
}

/** Remember the bank's earlier decisions and the ones people made on this desk, each with where it came from. */
function rememberAll(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  memory: PointerMemory,
  entryTable: string,
  rows: { bank: Row[]; desk: Row[] },
): Source {
  const source: Source = new Map();
  for (const [list, desk] of [
    [rows.bank, false],
    [rows.desk, true],
  ] as const) {
    for (const disposition of list) {
      const record = memory.remember(memoryOf(deps, evidence, disposition, entryTable));
      source.set(record.id, { row: disposition, desk });
    }
  }
  return source;
}

/** Recall what was decided before about this customer and listed party, and check it still holds. */
export async function recallMemory(
  deps: AgentDeps,
  tools: ReadonlyMap<string, EvidenceTool>,
  evidence: EvidenceBundle,
  queries: QueryEvidenceInput[],
): Promise<MemoryEvidence> {
  const tool = tools.get("find_disposition");
  const customerId = evidence.customer.customer_id;
  if (!tool || !customerId) return none();
  const found = await tool.find({ customer_id: customerId });
  queries.push(queryEvidenceOf(deps, found));

  const entryTable = evidence.model.tables.find((t) => t.name === "list_entry")?.qualifiedName ?? "list_entry";
  const memory = new PointerMemory({
    // The current state of the listed entry was already read through Zetaris for this review.
    lookup: (pointer) =>
      pointer.row_key.entry_id === evidence.entry.entry_id
        ? {
            content_hash: evidence.entry.content_hash ?? "",
            ...(evidence.entry.snapshot_id ? { list_snapshot_id: evidence.entry.snapshot_id } : {}),
          }
        : undefined,
  });
  const bankRows = found.rows.filter((d) => d.entry_id === evidence.entry.entry_id);
  // Decisions people made on this desk about the same customer and entry. They are kept as pointers too.
  const deskRows = deps.analystDecisions?.(customerId, evidence.entry.entry_id ?? "") ?? [];
  const source = rememberAll(deps, evidence, memory, entryTable, { bank: bankRows, desk: deskRows });
  supersedeEarlier(memory, source);
  const recalled = source.size > 0 ? await memory.recall(entryTable, { entry_id: evidence.entry.entry_id ?? "" }) : [];

  const fresh = recalled.some((r) => r.usable && r.memory.decision === "CLOSE_FALSE_POSITIVE");
  const stale = recalled.some((r) => r.reopen);
  const uses: MemoryUseInput[] = recalled.map((r) => ({
    memory_id: r.memory.memory_id,
    pointer_states: r.pointerStates,
    used: r.usable,
  }));
  deps.trace.log({
    agent: "memory",
    action: "recall",
    status: stale ? "blocked" : "ok",
    zetaris_query_id: found.query.query_id,
    input_summary: `customer ${customerId} and ${evidence.entry.entry_id}`,
    output_summary:
      recalled.length === 0
        ? "no earlier decision about this pair"
        : `${recalled.length} earlier decision(s): ${recalled.map((r) => `${r.memory.decision} (${r.pointerStates.join("+")})`).join("; ")}`,
    detail: { fresh, stale },
  });
  return { recalled, fresh, stale, uses, details: detailsOf(recalled, source) };
}

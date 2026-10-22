import { type ChunkConfig, Markovian, type MarkovianRun } from "../markovian/index.js";

/**
 * List-change re-screen: after a sanctions list is updated, find the earlier decisions whose listed entry
 * has changed or been removed.
 *
 *  - an entry whose content hash changed: the earlier decision may no longer hold, so the case is a
 *    re-open candidate (whatever the earlier decision was);
 *  - an entry that is gone (delisted): an escalation or block recommendation that rested on it becomes a
 *    release candidate for a person to confirm; an earlier close has nothing left to release;
 *  - an unchanged entry: nothing to do.
 *
 * The work is cut into bounded batches. It runs on the Markovian engine as a chain of chunks with a small
 * carried state (the cursor and the running counts), so a very large portfolio is processed in steps and a
 * run that hits the chunk limit can be resumed from the cursor it returns.
 */

export type EarlierDecision = "CLOSE_FALSE_POSITIVE" | "ESCALATE_L2" | "RECOMMEND_BLOCK" | "NEED_MORE_INFO";

export interface DispositionRef {
  disposition_id: string;
  customer_id: string;
  entry_id: string;
  decision: EarlierDecision;
  /** Content hash of the listed entry when the decision was made. */
  entry_content_hash: string;
  list_snapshot_id?: string;
}

export interface CurrentEntry {
  content_hash: string;
  list_snapshot_id?: string;
}

/** Looks up the current entries. An entry id missing from the map has been removed from the list. */
export type EntryLookup = (entryIds: readonly string[]) => Promise<ReadonlyMap<string, CurrentEntry>>;

export interface RescreenOptions {
  /** Dispositions examined per batch. Default 50. */
  batchSize?: number;
  /** Most batches in one run (the Markovian chunk limit, 1 to 32). Default 32. */
  maxBatches?: number;
  /** Where to continue, from an earlier incomplete run. Default 0. */
  startCursor?: number;
}

export type ReasonCode = "ENTRY_CHANGED" | "ENTRY_DELISTED";

export interface RescreenCandidate {
  disposition_id: string;
  customer_id: string;
  entry_id: string;
  earlier_decision: EarlierDecision;
  reason_code: ReasonCode;
  /** The hash recorded then and the hash now (absent when the entry is gone). */
  earlier_hash: string;
  current_hash?: string;
  current_snapshot_id?: string;
}

export interface RescreenResult {
  total: number;
  examined: number;
  batches: number;
  /** Index to continue from, or null when every disposition was examined. */
  nextCursor: number | null;
  complete: boolean;
  reopen: RescreenCandidate[];
  release: RescreenCandidate[];
  unchanged: number;
  /** Delisted entries behind a decision that needs no release (an earlier close). */
  moot: number;
  chunkConfig: ChunkConfig;
  status: MarkovianRun["status"];
}

const DEFAULT_BATCH = 50;
const HOLDING: readonly EarlierDecision[] = ["ESCALATE_L2", "RECOMMEND_BLOCK"];

/** Judge one disposition against the current entry. */
export function judgeDisposition(
  d: DispositionRef,
  current: CurrentEntry | undefined,
): { kind: "reopen" | "release" | "unchanged" | "moot"; candidate?: RescreenCandidate } {
  const base = {
    disposition_id: d.disposition_id,
    customer_id: d.customer_id,
    entry_id: d.entry_id,
    earlier_decision: d.decision,
    earlier_hash: d.entry_content_hash,
  };
  if (!current) {
    return HOLDING.includes(d.decision)
      ? { kind: "release", candidate: { ...base, reason_code: "ENTRY_DELISTED" } }
      : { kind: "moot" };
  }
  if (current.content_hash === d.entry_content_hash) return { kind: "unchanged" };
  return {
    kind: "reopen",
    candidate: {
      ...base,
      reason_code: "ENTRY_CHANGED",
      current_hash: current.content_hash,
      ...(current.list_snapshot_id !== undefined ? { current_snapshot_id: current.list_snapshot_id } : {}),
    },
  };
}

const carried = (cursor: number, total: number, reopen: number, release: number): string =>
  `COMPLETED: examined ${cursor} of ${total} dispositions\nREMAINING: ${total - cursor}\nDECISIONS: reopen=${reopen} release=${release}\nCONTEXT: cursor=${cursor}`;

function cursorOf(carryover: string, fallback: number): number {
  const m = /cursor=(\d+)/.exec(carryover);
  return m ? Number(m[1]) : fallback;
}

interface Tally {
  unchanged: number;
  moot: number;
  batches: number;
  cursor: number;
}

/** Look up the batch's entries once and sort each disposition into its bucket. */
async function examine(
  batch: readonly DispositionRef[],
  lookup: EntryLookup,
  out: { reopen: RescreenCandidate[]; release: RescreenCandidate[]; tally: Tally },
): Promise<void> {
  if (batch.length === 0) return;
  const current = await lookup([...new Set(batch.map((d) => d.entry_id))]);
  for (const d of batch) {
    const verdict = judgeDisposition(d, current.get(d.entry_id));
    if (verdict.kind === "reopen" && verdict.candidate) out.reopen.push(verdict.candidate);
    else if (verdict.kind === "release" && verdict.candidate) out.release.push(verdict.candidate);
    else if (verdict.kind === "moot") out.tally.moot += 1;
    else out.tally.unchanged += 1;
  }
}

export async function rescreen(
  dispositions: readonly DispositionRef[],
  lookup: EntryLookup,
  options: RescreenOptions = {},
): Promise<RescreenResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const total = dispositions.length;
  const start = options.startCursor ?? 0;
  const reopen: RescreenCandidate[] = [];
  const release: RescreenCandidate[] = [];
  const tally: Tally = { unchanged: 0, moot: 0, batches: 0, cursor: start };

  const engine = new Markovian({
    chunkConfig: { maxChunks: options.maxBatches ?? 32 },
    // The worker is plain code, not a model: the engine supplies the chunking, the carried state and the limit.
    generator: async () => ({ text: "" }),
  });

  const run = await engine.run({
    goal: `re-screen ${total} dispositions after a list change`,
    reflect: false,
    stepFn: async ({ carryover }) => {
      const cursor = cursorOf(carryover, tally.cursor);
      const batch = dispositions.slice(cursor, cursor + batchSize);
      await examine(batch, lookup, { reopen, release, tally });
      tally.cursor = cursor + batch.length;
      tally.batches += 1;
      const finished = tally.cursor >= total;
      const state = carried(tally.cursor, total, reopen.length, release.length);
      return {
        content: `batch ${tally.batches}: examined ${batch.length}\n${finished ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\n${state}`}`,
      };
    },
  });

  const complete = tally.cursor >= total;
  return {
    total,
    examined: tally.cursor - start,
    batches: tally.batches,
    nextCursor: complete ? null : tally.cursor,
    complete,
    reopen,
    release,
    unchanged: tally.unchanged,
    moot: tally.moot,
    chunkConfig: run.chunkConfig,
    status: run.status,
  };
}

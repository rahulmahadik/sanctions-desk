/**
 * Whether a close was proposed and stopped in a recorded review, and by what. Read from the sealed record and the run's
 * own trace, never inferred: a close was stopped when the decision step's first recommendation was a close and the
 * final recommendation is not. Used by the alert list and the case view.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DecisionRecord, readTrace, type TraceEvent } from "@sanctions-desk/shared";

export type StoppedBy = "critic" | "policy guard" | "screener" | "data quality";

export interface CloseStop {
  /** True when the decision step first recommended a close and the final recommendation is something else. */
  stopped: boolean;
  by: StoppedBy[];
  /** The guard verdicts or critic verdict that stopped it, in plain words. */
  reasons: string[];
}

const NONE: CloseStop = { stopped: false, by: [], reasons: [] };

/** Which kind of check a guard belongs to, for the chip on the alert list. */
export function stoppedByOf(guard: string): StoppedBy {
  if (guard.startsWith("screener")) return "screener";
  if (guard === "data_quality" || guard === "missing_data") return "data quality";
  if (guard === "critic_unresolved") return "critic";
  return "policy guard";
}

/** The events of the newest run in a trace file (a file can hold several runs of one case, each starting at 0). */
function lastRun(events: readonly TraceEvent[]): TraceEvent[] {
  const start = events.map((e) => e.seq).lastIndexOf(0);
  return events.slice(Math.max(0, start));
}

export function closeStop(record: DecisionRecord, events: readonly TraceEvent[]): CloseStop {
  const run = lastRun(events);
  const first = run.find((e) => e.agent === "decision" && e.action === "recommend");
  const proposedClose = first?.output_summary?.startsWith("CLOSE_FALSE_POSITIVE") ?? false;
  if (!proposedClose || record.decision === "CLOSE_FALSE_POSITIVE") return NONE;

  const blocks = record.guards.filter((g) => g.verdict === "block");
  const by = new Set<StoppedBy>(blocks.map((g) => stoppedByOf(g.guard)));
  const reasons = blocks.map((g) => `${g.guard.replaceAll("_", " ")}: ${g.detail ?? "blocked"}`);
  // The critic sent the close back, and the decision step then changed its answer before any guard ran.
  const criticBlocked = run.some((e) => e.agent === "critic" && e.action === "judge" && e.status === "blocked");
  if (criticBlocked && blocks.length === 0) {
    by.add("critic");
    reasons.push(`critic: ${record.critic.final_verdict} after ${record.critic.rounds} round(s)`);
  }
  return { stopped: true, by: [...by], reasons };
}

/** Read the run's trace beside the record and answer for it; a record whose trace is gone answers "not known". */
export function closeStopFromLogs(logDir: string, record: DecisionRecord): CloseStop | null {
  const file = join(logDir, `trace-${record.run_id}.jsonl`);
  if (!existsSync(file)) return null;
  try {
    return closeStop(record, readTrace(file));
  } catch {
    return null;
  }
}

export type Severity = "high" | "medium" | "low";

/**
 * How strong the name match behind an alert is, from its match score: high at 0.95 or more (an exact or near-exact
 * name), medium at or above the policy's name threshold, low below it. A display order, not a decision.
 */
export function severityOf(matchScore: number, nameThreshold: number): Severity {
  if (matchScore >= 0.95) return "high";
  return matchScore >= nameThreshold ? "medium" : "low";
}

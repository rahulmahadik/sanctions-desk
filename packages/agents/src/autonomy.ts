import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AutonomyRecord, Decision, DecisionRecord, GuardVerdictInput, Policy } from "@sanctions-desk/shared";
import { readDecisionRecords } from "./record.js";

/**
 * Configurable autonomy. At level 0 a person approves every alert. At level 1 a close the desk is certain of may be
 * closed without waiting, and only a close: escalations, requests for information and blocks always go to a person,
 * and a block always needs two different approvers. These locks are fixed in the policy schema and are not
 * conditions here, so no setting can loosen them.
 *
 * A close is automatic only when every condition holds:
 *   level_one            the policy is at level 1 and the kill switch is off
 *   outcome_is_close     the final recommendation is a close
 *   deterministic_close  code, from the structured fields alone, also concluded a close and found it settled
 *   decision_agrees      the decision agent recommended a close
 *   critic_approved      the critic re-read the cited facts and approved
 *   challenger_agrees    the challenger found no credible argument (or was not needed)
 *   evidence_standard    free text relied on meets the documentary standard (or none was relied on)
 *   no_data_quality_issue no data-quality rule fails on the records
 *   no_policy_block      the policy guard raised nothing
 *   confidence           the confidence is at least the policy's line
 * and then within the daily cap; a random share (at least 5 percent) goes to a person as a quality-assurance sample.
 */

export type AutonomyOutcome = AutonomyRecord["outcome"];

export interface AutonomyInput {
  policy: Policy;
  killSwitch: boolean;
  final: Decision;
  modelDecision: Decision;
  firstFinding?: { decision: Decision; settled: boolean };
  confidence: number;
  critic: { final_verdict: string };
  guards: readonly GuardVerdictInput[];
  dataQualityFailed: boolean;
  autoClosedToday: number;
  /** A number in [0, 1) drawn for the quality-assurance sample. */
  draw: number;
}

export const randomDraw = (): number => randomInt(0, 1_000_000) / 1_000_000;

export function decideAutonomy(input: AutonomyInput): AutonomyRecord {
  const { policy } = input;
  const a = policy.autonomy;
  const levelInForce: 0 | 1 = a.level === 1 && !input.killSwitch ? 1 : 0;
  const verdict = (name: string) => input.guards.find((g) => g.guard === name)?.verdict;
  const closes = input.final === "CLOSE_FALSE_POSITIVE";
  const conditions: AutonomyRecord["conditions"] = [
    {
      name: "level_one",
      met: levelInForce === 1,
      ...(input.killSwitch && a.level === 1 ? { detail: "the kill switch is on" } : {}),
    },
    { name: "outcome_is_close", met: closes, ...(closes ? {} : { detail: `the recommendation is ${input.final}` }) },
    {
      name: "deterministic_close",
      met: input.firstFinding?.decision === "CLOSE_FALSE_POSITIVE" && input.firstFinding.settled,
      ...(input.firstFinding
        ? {
            detail: `first finding ${input.firstFinding.decision}${input.firstFinding.settled ? "" : " (not settled)"}`,
          }
        : {}),
    },
    { name: "decision_agrees", met: input.modelDecision === "CLOSE_FALSE_POSITIVE" },
    { name: "critic_approved", met: input.critic.final_verdict === "approved" },
    { name: "challenger_agrees", met: verdict("challenger") !== "block" },
    { name: "evidence_standard", met: verdict("evidence_standard") === "pass" },
    { name: "no_data_quality_issue", met: !input.dataQualityFailed },
    { name: "no_policy_block", met: input.guards.every((g) => g.verdict !== "block") },
    {
      name: "confidence",
      met: input.confidence >= a.autoClose.confidenceAtLeast,
      detail: `${input.confidence} against ${a.autoClose.confidenceAtLeast}`,
    },
  ];
  const allMet = conditions.every((c) => c.met);
  const underCap = input.autoClosedToday < a.autoClose.dailyCap;
  if (allMet && !underCap) {
    conditions.push({
      name: "daily_cap",
      met: false,
      detail: `${a.autoClose.dailyCap} automatic closes already today`,
    });
  }
  const sampled = allMet && underCap && input.draw < a.autoClose.qaSampleRate;
  const outcome: AutonomyOutcome = !allMet || !underCap ? "human_review" : sampled ? "qa_sample" : "auto_closed";
  const base = {
    policy_level: a.level,
    level_in_force: levelInForce,
    outcome,
    conditions,
    qa_draw: input.draw,
    qa_rate: a.autoClose.qaSampleRate,
  };
  return outcome === "auto_closed"
    ? {
        ...base,
        statement: `closed automatically under policy v${policy.version}, level 1, conditions met: ${conditions
          .map((c) => c.name)
          .join(", ")}`,
      }
    : base;
}

// ---- the kill switch ----------------------------------------------------------------------------

export interface KillSwitchState {
  active: boolean;
  by: string;
  at: string;
  reason: string;
}

const killFile = (logDir: string): string => join(logDir, "decisions", "kill-switch.json");

/** The current state. Missing or unreadable means off, so a damaged file cannot switch autonomy on by itself. */
export function readKillSwitch(logDir: string): KillSwitchState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(killFile(logDir), "utf8")) as KillSwitchState;
    return typeof parsed.active === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const killSwitchOn = (logDir: string): boolean => readKillSwitch(logDir)?.active === true;

export function setKillSwitch(logDir: string, state: KillSwitchState): void {
  const file = killFile(logDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
}

// ---- what has been closed automatically ------------------------------------------------------------

const utcDay = (iso: string): string => iso.slice(0, 10);

/** The latest record per alert whose autonomy outcome is `auto_closed`, newest first. */
export function autoClosedRecords(logDir: string): DecisionRecord[] {
  const seen = new Set<string>();
  const out: DecisionRecord[] = [];
  for (const r of readDecisionRecords(logDir)) {
    if (seen.has(r.alert_ref)) continue;
    seen.add(r.alert_ref);
    if (r.autonomy?.outcome === "auto_closed") out.push(r);
  }
  return out;
}

export interface AutonomyUsage {
  day: string;
  auto_closed: number;
  qa_sample: number;
  reopened: number;
}

/** Automatic closes and quality-assurance samples recorded today (UTC). Counts every record, so a reopened close still counts. */
export function autonomyUsage(logDir: string, now: Date): AutonomyUsage {
  const day = utcDay(now.toISOString());
  let autoClosed = 0;
  let qa = 0;
  let reopened = 0;
  const counted = new Set<string>();
  for (const r of readDecisionRecords(logDir)) {
    if (utcDay(r.decided_at) !== day || !r.autonomy) continue;
    // A record a person acted on shares its run with the original; count each run once.
    const reopenedNow = r.human.some((h) => h.action === "reopen");
    if (counted.has(r.run_id)) continue;
    counted.add(r.run_id);
    if (r.autonomy.outcome === "auto_closed") {
      autoClosed += 1;
      if (reopenedNow) reopened += 1;
    }
    if (r.autonomy.outcome === "qa_sample") qa += 1;
  }
  return { day, auto_closed: autoClosed, qa_sample: qa, reopened };
}

export const hasKillSwitchFile = (logDir: string): boolean => existsSync(killFile(logDir));

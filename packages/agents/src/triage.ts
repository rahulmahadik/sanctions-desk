import type { AlertType } from "@sanctions-desk/shared";
import type { MatchResult } from "./matching.js";
import type { AgentDeps } from "./types.js";

/** Triage: decide the path for an alert before any data is read, and judge how hard it looks afterwards. */

export interface TriagePlan {
  alertType: AlertType;
  alertId: string;
  maxCriticRounds: number;
}

export function triage(deps: AgentDeps, alertType: AlertType, alertId: string): TriagePlan {
  const plan: TriagePlan = { alertType, alertId, maxCriticRounds: deps.policy.critic.maxRounds };
  deps.trace.log({
    agent: "triage",
    action: "plan",
    status: "ok",
    target_agent: "evidence",
    input_summary: `${alertType} alert ${alertId}`,
    output_summary: `path: ${alertType} review; the critic may send the recommendation back up to ${plan.maxCriticRounds} times`,
  });
  return plan;
}

export type Difficulty = "clear" | "contested";

/**
 * A clear case is one where every field agrees or every field conflicts. Anything mixed is contested. The review
 * records the difficulty on the trace; the value returned is not used to route the case.
 */
export function judgeDifficulty(deps: AgentDeps, match: MatchResult): Difficulty {
  const c = match.comparison;
  const difficulty: Difficulty =
    c.assessment === "strong" ||
    (c.assessment === "weak" && c.dob.status === "conflict" && c.country.status === "conflict")
      ? "clear"
      : "contested";
  deps.trace.log({
    agent: "triage",
    action: "difficulty",
    status: "ok",
    output_summary: `${difficulty} (${c.assessment}; date of birth ${c.dob.status}; country ${c.country.status})`,
  });
  return difficulty;
}

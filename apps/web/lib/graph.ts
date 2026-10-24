import type { RunEvent } from "./types";

/** The steps of a review, in the order a case moves through them. */
export const STEPS = [
  { id: "triage", label: "Triage", model: false },
  { id: "evidence", label: "Evidence", model: false },
  { id: "screener", label: "Screener", model: true },
  { id: "memory", label: "Memory", model: false },
  { id: "matching", label: "Matching", model: false },
  { id: "ownership", label: "Ownership", model: false },
  { id: "decision", label: "Decision", model: true },
  { id: "critic", label: "Critic", model: true },
  { id: "challenger", label: "Challenger", model: true },
  { id: "policy_guard", label: "Policy guard", model: true },
  { id: "reporter", label: "Reporter", model: false },
] as const;

type StepId = (typeof STEPS)[number]["id"];
type StepState = "idle" | "running" | "done" | "retry" | "flagged" | "error" | "skipped";

export interface StepView {
  id: StepId;
  label: string;
  state: StepState;
  events: number;
  /** How many times the step had to try again (a model answer that was unusable, or a critic round sent back). */
  retries: number;
  lastSummary?: string;
  model?: string;
  requested?: string;
  route?: "local" | "cloud" | null;
  latencyMs?: number;
  receiptId?: string;
}

export interface GraphView {
  steps: StepView[];
  /** The critic's current round (1-based) and the most rounds the policy allows. */
  criticRound: number;
  criticMaxRounds: number;
  finished: boolean;
  failed: boolean;
  total: number;
}

export const CRITIC_MAX_ROUNDS = 3;

const stateOf = (event: RunEvent): StepState => {
  if (event.agent === "critic" && event.action === "judge" && event.status === "blocked") return "retry";
  if (event.status === "error") return "error";
  // A check that holds a case back (a screener signal, a guard raising the outcome) is doing its job: flagged.
  if (event.status === "blocked") return "flagged";
  if (event.status === "retry") return "retry";
  if (event.status === "skipped") return "skipped";
  return "done";
};

/** Record one step event on its node. */
function applyToStep(step: StepView, event: RunEvent): void {
  step.events += 1;
  step.state = stateOf(event);
  if (event.status === "retry") step.retries += 1;
  if (event.output_summary) step.lastSummary = event.output_summary;
  if (event.model_used) step.model = event.model_used;
  if (event.model_requested) step.requested = event.model_requested;
  if (event.receipt?.receipt_id) step.receiptId = event.receipt.receipt_id;
  if (event.route_kind !== undefined) step.route = event.route_kind;
  if (event.latency_ms !== undefined) step.latencyMs = event.latency_ms;
  // A rejected critic round sends the recommendation back to the decision step: a retry, not a failure.
  if (event.agent === "critic" && event.action === "judge" && event.status === "blocked") step.retries += 1;
}

/**
 * Work out how the graph looks after the first `upTo` events. The same function drives the live view (all
 * events so far) and the replay slider (some of them), so what is drawn always comes from recorded events.
 */
export function graphAt(events: readonly RunEvent[], upTo: number = events.length): GraphView {
  const seen = events.slice(0, upTo);
  const steps: StepView[] = STEPS.map((s) => ({ id: s.id, label: s.label, state: "idle", events: 0, retries: 0 }));
  const byId = new Map(steps.map((s) => [s.id as string, s]));
  const end = seen.find(
    (e) => e.agent === "system" && ["run_completed", "run_failed", "run_rejected"].includes(e.action),
  );
  const failed = end !== undefined && end.action !== "run_completed";

  for (const event of seen) {
    const step = byId.get(event.agent);
    if (step) applyToStep(step, event);
  }
  const criticRound = seen.filter((e) => e.agent === "critic" && e.action === "judge").length;

  // The step that is working now is the last one with events, until the run ends.
  if (end === undefined) {
    const last = [...steps].reverse().find((s) => s.events > 0);
    if (last?.state === "done") last.state = "running";
  }
  return {
    steps,
    criticRound,
    criticMaxRounds: CRITIC_MAX_ROUNDS,
    finished: end !== undefined,
    failed,
    total: seen.length,
  };
}

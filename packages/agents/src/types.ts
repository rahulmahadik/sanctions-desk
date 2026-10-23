import type { Config, Generator, Policy, QueryEvidenceInput, TraceLogger } from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";

export type { QueryEvidenceInput };

/** Everything an agent step may use. Agents never reach for a global. */
export interface AgentDeps {
  config: Config;
  /** The policy version this run started with. It does not change while the run is in progress. */
  policy: Policy;
  zetaris: ZetarisClient;
  /** The one model seam. Which provider answers is decided by configuration, not by the agent. */
  generator: Generator;
  trace: TraceLogger;
  now: () => Date;
  /** Wait between tries after a provider failure. Tests pass a no-op; the default really waits. */
  sleep?: (ms: number) => Promise<void>;
  /** True when the kill switch has forced autonomy level 0. Evaluation runs leave it out. */
  killSwitch?: () => boolean;
  /** Automatic closes already made today (UTC), for the daily cap. */
  autoClosedToday?: () => number;
  /** A number in [0, 1) for the quality-assurance sample. Tests pass a fixed one. */
  random?: () => number;
  /**
   * Decisions that people made on earlier recommendations about a customer and a listed entry. Read by the memory
   * step beside the bank's own earlier decisions. Evaluation runs leave it out so the exam stays independent.
   */
  analystDecisions?: (customerId: string, entryId: string) => Row[];
}

export type Row = Record<string, string | null>;

export interface FactCitation {
  table: string;
  key_value: string;
  column: string;
  value: string | null;
}

/** The Zetaris client limited to what one agent may read, as the active policy says. */
export function clientFor(
  deps: Pick<AgentDeps, "zetaris" | "policy">,
  agent: keyof AgentDeps["policy"]["agentAccess"],
): ZetarisClient {
  return deps.zetaris.scoped({ agent, ...deps.policy.agentAccess[agent] });
}

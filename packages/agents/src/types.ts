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

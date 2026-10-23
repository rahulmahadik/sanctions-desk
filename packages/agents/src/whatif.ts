import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, createTraceLogger, type Decision, type Generator, type Policy } from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import { runReview } from "./pipeline.js";

export interface WhatIfCase {
  case_id: string;
  kind: string;
  group: string;
  alert_id: string;
  expected: string;
  must_not: readonly string[];
}

export interface WhatIfRow {
  case_id: string;
  kind: string;
  group: string;
  expected: string;
  current: Decision | "ERROR";
  proposed: Decision | "ERROR";
  changed: boolean;
  /** The proposed policy closes a case that the exam says must never be closed. */
  new_false_close: boolean;
  /** The proposed policy is less cautious: it moves toward closing. */
  less_cautious: boolean;
  error?: string;
}

export interface WhatIfReport {
  current_version: number;
  proposed_version: number;
  cases: number;
  changed: number;
  new_false_closes: number;
  less_cautious: number;
  errors: number;
  rows: WhatIfRow[];
}

/** From most to least cautious. */
const CAUTION: Record<string, number> = {
  RECOMMEND_BLOCK: 3,
  ESCALATE_L2: 2,
  NEED_MORE_INFO: 1,
  CLOSE_FALSE_POSITIVE: 0,
};

export interface WhatIfDeps {
  config: Config;
  zetaris: ZetarisClient;
  generator: Generator;
  now: () => Date;
}

async function decide(deps: WhatIfDeps, policy: Policy, dir: string, tag: string, c: WhatIfCase) {
  const runId = `whatif-${tag}-${c.case_id}`;
  const trace = createTraceLogger({ runId, dir, stdout: false, policyVersion: policy.version });
  const config = { ...deps.config, logging: { ...deps.config.logging, dir } };
  const answer = await runReview(
    { config, policy, zetaris: deps.zetaris, generator: deps.generator, trace, now: deps.now },
    { runId, alertId: c.alert_id, sampleMode: deps.config.sampleMode },
  );
  return (answer.decision ?? "ERROR") as Decision | "ERROR";
}

/**
 * Review the same cases under the active policy and under a draft, and report what changes. Nothing is kept:
 * the runs write into a temporary folder that is removed, so the audit trail and the sealed records of real
 * reviews are not touched, and no policy changes.
 */
export async function replayWhatIf(
  deps: WhatIfDeps,
  input: { cases: readonly WhatIfCase[]; current: Policy; proposed: Policy },
): Promise<WhatIfReport> {
  const dir = mkdtempSync(join(tmpdir(), "whatif-"));
  const rows: WhatIfRow[] = [];
  try {
    for (const c of input.cases) {
      const base = { case_id: c.case_id, kind: c.kind, group: c.group, expected: c.expected };
      try {
        const current = await decide(deps, input.current, dir, `v${input.current.version}`, c);
        const proposed = await decide(deps, input.proposed, dir, `v${input.proposed.version}`, c);
        rows.push({
          ...base,
          current,
          proposed,
          changed: current !== proposed,
          new_false_close: proposed === "CLOSE_FALSE_POSITIVE" && c.must_not.includes("CLOSE_FALSE_POSITIVE"),
          less_cautious: (CAUTION[proposed] ?? 0) < (CAUTION[current] ?? 0),
        });
      } catch (err) {
        rows.push({
          ...base,
          current: "ERROR",
          proposed: "ERROR",
          changed: false,
          new_false_close: false,
          less_cautious: false,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    current_version: input.current.version,
    proposed_version: input.proposed.version,
    cases: rows.length,
    changed: rows.filter((r) => r.changed).length,
    new_false_closes: rows.filter((r) => r.new_false_close).length,
    less_cautious: rows.filter((r) => r.less_cautious).length,
    errors: rows.filter((r) => r.current === "ERROR" || r.proposed === "ERROR").length,
    rows,
  };
}

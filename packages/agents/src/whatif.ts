import { createHash } from "node:crypto";
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
  /** What the proposed policy's autonomy setting would do with the case; absent when it is at level 0. */
  autonomy?: "human_review" | "auto_closed" | "qa_sample";
  /** The case would be closed automatically although the exam says it carries real risk. */
  autonomy_false_close?: boolean;
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
  /** For a draft at autonomy level 1: how it would treat these cases. The exam's false closes must be 0. */
  autonomy?: AutonomyWhatIf;
  rows: WhatIfRow[];
}

export interface AutonomyWhatIf {
  level: 1;
  cases: number;
  auto_closed: number;
  qa_sample: number;
  human_review: number;
  /** Cases closed automatically that carry real risk. */
  false_closes: number;
  /** The daily cap and the sample rate used. */
  cap: number;
  qa_rate: number;
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

/** A stable number in [0, 1) for a case, so a replay samples the same cases every time. */
const drawFor = (policyVersion: number, caseId: string): number => {
  const h = createHash("sha256").update(`${policyVersion}:${caseId}`).digest();
  return h.readUInt32BE(0) / 2 ** 32;
};

async function decide(
  deps: WhatIfDeps,
  policy: Policy,
  dir: string,
  tag: string,
  c: WhatIfCase,
  closedSoFar: () => number = () => 0,
) {
  const runId = `whatif-${tag}-${c.case_id}`;
  const trace = createTraceLogger({ runId, dir, stdout: false, policyVersion: policy.version });
  const config = { ...deps.config, logging: { ...deps.config.logging, dir } };
  const answer = await runReview(
    {
      config,
      policy,
      zetaris: deps.zetaris,
      generator: deps.generator,
      trace,
      now: deps.now,
      random: () => drawFor(policy.version, c.case_id),
      autoClosedToday: closedSoFar,
    },
    { runId, alertId: c.alert_id, sampleMode: deps.config.sampleMode },
  );
  return { decision: (answer.decision ?? "ERROR") as Decision | "ERROR", autonomy: answer.autonomy?.outcome };
}

const RISK = "CLOSE_FALSE_POSITIVE";

/** One case replayed under both policies. */
async function replayCase(
  deps: WhatIfDeps,
  input: { current: Policy; proposed: Policy },
  dir: string,
  c: WhatIfCase,
  closedSoFar: number,
): Promise<{ row: WhatIfRow; closed: boolean }> {
  const base = { case_id: c.case_id, kind: c.kind, group: c.group, expected: c.expected };
  try {
    const current = (await decide(deps, input.current, dir, `v${input.current.version}`, c)).decision;
    const answer = await decide(deps, input.proposed, dir, `v${input.proposed.version}`, c, () => closedSoFar);
    const proposed = answer.decision;
    return {
      closed: answer.autonomy === "auto_closed",
      row: {
        ...base,
        current,
        proposed,
        changed: current !== proposed,
        new_false_close: proposed === RISK && c.must_not.includes(RISK),
        less_cautious: (CAUTION[proposed] ?? 0) < (CAUTION[current] ?? 0),
        ...(answer.autonomy
          ? {
              autonomy: answer.autonomy,
              autonomy_false_close: answer.autonomy === "auto_closed" && c.must_not.includes(RISK),
            }
          : {}),
      },
    };
  } catch (err) {
    return {
      closed: false,
      row: {
        ...base,
        current: "ERROR",
        proposed: "ERROR",
        changed: false,
        new_false_close: false,
        less_cautious: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      },
    };
  }
}

const autonomySummary = (proposed: Policy, rows: readonly WhatIfRow[]): AutonomyWhatIf | undefined =>
  proposed.autonomy.level === 1
    ? {
        level: 1,
        cases: rows.length,
        auto_closed: rows.filter((r) => r.autonomy === "auto_closed").length,
        qa_sample: rows.filter((r) => r.autonomy === "qa_sample").length,
        human_review: rows.filter((r) => r.autonomy === "human_review").length,
        false_closes: rows.filter((r) => r.autonomy_false_close).length,
        cap: proposed.autonomy.autoClose.dailyCap,
        qa_rate: proposed.autonomy.autoClose.qaSampleRate,
      }
    : undefined;

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
  let closedSoFar = 0;
  try {
    for (const c of input.cases) {
      const done = await replayCase(deps, input, dir, c, closedSoFar);
      if (done.closed) closedSoFar += 1;
      rows.push(done.row);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const autonomy = autonomySummary(input.proposed, rows);
  return {
    current_version: input.current.version,
    proposed_version: input.proposed.version,
    cases: rows.length,
    changed: rows.filter((r) => r.changed).length,
    new_false_closes: rows.filter((r) => r.new_false_close).length,
    less_cautious: rows.filter((r) => r.less_cautious).length,
    errors: rows.filter((r) => r.current === "ERROR" || r.proposed === "ERROR").length,
    ...(autonomy ? { autonomy } : {}),
    rows,
  };
}

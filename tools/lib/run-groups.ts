/**
 * Which group an exported run in eval/runs belongs to. The groups are reported apart and never added together:
 *
 * - `recorded`: the evaluation runs (the first system's runs, its baselines and the held-out rounds, systems up to sys4);
 * - `current-system`: runs of the current system, whose run id carries a system label of sys5 or later;
 * - `nemotron-alone`: the Nemotron-alone study arm (run-meta variant `nemotron_alone`), whatever its label.
 *
 * Read by npm run receipt:stats and npm run nemotron:scorecard, so both count the same runs.
 */

export type RunGroupId = "recorded" | "current-system" | "nemotron-alone";

/** The first system label of the current system; runs labelled with it or a later one are counted apart. */
export const CURRENT_SYSTEM_FROM = 5;

/** The system number in a run id ("heldout4-sys4-routed-..." gives 4, "sys5-routed-..." 5), or undefined. */
export function systemNumber(runId: string): number | undefined {
  const m = /(?:^|-)sys(\d+)[a-z]*-/.exec(runId);
  return m ? Number(m[1]) : undefined;
}

/** The group of one exported run, from its run id and the variant in its run-meta.json. */
export function runGroup(runId: string, variant: string): RunGroupId {
  if (variant === "nemotron_alone") return "nemotron-alone";
  const sys = systemNumber(runId);
  if (sys !== undefined && sys >= CURRENT_SYSTEM_FROM) return "current-system";
  return "recorded";
}

/** The plain label of each group, with the number of exported runs in it. */
export function runGroupLabel(group: RunGroupId, runs: number): string {
  const n = `${runs} exported run${runs === 1 ? "" : "s"} in eval/runs`;
  switch (group) {
    case "recorded":
      return `Recorded evaluation runs (${n}: the first system's runs, the baselines and the held-out rounds, systems up to sys4)`;
    case "current-system":
      return `Current-system runs (${n} with a system label of sys${CURRENT_SYSTEM_FROM} or later; not part of the recorded evaluation runs)`;
    case "nemotron-alone":
      return `Nemotron alone, study arm (${n}; one decision call per case, without the guard, screener, critic or challenger; not part of the recorded evaluation runs)`;
  }
}

export const RUN_GROUP_ORDER: readonly RunGroupId[] = ["recorded", "current-system", "nemotron-alone"];

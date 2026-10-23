/**
 * Which Nemotron model does what, and does it matter? For the decision step, compare the cases whose final decision
 * was answered by Nemotron 3 Ultra (cloud) with those answered by Nemotron 3.5 Lightning (local), from the sealed
 * records of the newest complete full-system runs of the main exam and the held-out set: accuracy, false closes,
 * wrong citations the critic caught, time and cost per alert. A run of the `lightning` variant, which sends the
 * decision, critic and challenger to the local model, is shown beside them when it exists, labelled as an extra run.
 *
 *   npm run study:models
 *
 * Writes eval/model-study.json and eval/MODEL-STUDY.md. The router, not this study, decides which model answers a
 * call, so the groups are not a controlled experiment: harder cases may go to one model more often.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTraceContract,
  readDecisionRecords,
  readRunEvents,
  type ScoredCase,
  scoreCase,
} from "@sanctions-desk/agents";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";

const config = loadConfig();
const logDir = resolveProjectPath(config.logging.dir);
const dir = join(projectRoot(), "eval", "results");

interface Run {
  variant: string;
  exam?: string;
  tag?: string;
  selection?: { groups?: unknown; kinds?: unknown; limit?: unknown };
  started_at: string;
  cases: ScoredCase[];
  file: string;
}
const runs = readdirSync(dir)
  .filter((n) => n.endsWith(".json") && !n.startsWith("bench"))
  .map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Run), file: f }))
  .filter((r) => !r.tag && !r.selection?.kinds && !r.selection?.groups && !r.selection?.limit)
  .sort((a, b) => a.started_at.localeCompare(b.started_at));
const newest = (variant: string, exam: string) =>
  runs.filter((r) => r.variant === variant && (r.exam ?? "exam") === exam).at(-1);

const kindOf = (model: string): "ultra" | "lightning" | "other" =>
  /ultra/i.test(model) ? "ultra" : /lightning/i.test(model) ? "lightning" : "other";
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)] as number);
};
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((t, x) => t + x, 0) / xs.length);

interface Row {
  case_id: string;
  served: "ultra" | "lightning" | "other";
  acceptable: boolean;
  exact: boolean;
  false_close: boolean;
  citation_catches: number;
  seconds: number;
  cost: number;
}

function rowsOf(run: Run): Row[] {
  const prefix = run.exam === "heldout" ? "eval-heldout" : "eval";
  const out: Row[] = [];
  for (const c of run.cases) {
    if (c.error !== undefined || c.got === "DRAFT_BLOCKED" || c.got === "DRAFT_ALLOWED") continue;
    const [record] = readDecisionRecords(logDir, (r) => r.run_id === `${prefix}-${run.variant}-${c.case_id}`);
    const decisionCalls = record?.models.filter((m) => m.agent === "decision") ?? [];
    const last = decisionCalls.at(-1);
    if (!record || !last) continue;
    const s = scoreCase(c);
    const events = readRunEvents(logDir, record);
    const catches = events.filter(
      (e) => e.agent === "critic" && e.action === "verify_facts" && e.status === "blocked",
    ).length;
    const contract = buildTraceContract(record, config.costs);
    out.push({
      case_id: c.case_id,
      served: kindOf(last.model_routed),
      acceptable: s.acceptable,
      exact: s.exact,
      false_close: s.falseClose,
      citation_catches: catches,
      seconds: c.latency_s ?? 0,
      cost: contract.cost.totals.model_cost,
    });
  }
  return out;
}

interface Group {
  group: string;
  cases: number;
  exact: number;
  acceptable: number;
  false_closes: number;
  citation_catches: number;
  median_seconds: number;
  mean_cost: number;
}
const summarise = (name: string, rows: Row[]): Group => ({
  group: name,
  cases: rows.length,
  exact: rows.filter((r) => r.exact).length,
  acceptable: rows.filter((r) => r.acceptable).length,
  false_closes: rows.filter((r) => r.false_close).length,
  citation_catches: rows.reduce((t, r) => t + r.citation_catches, 0),
  median_seconds: median(rows.map((r) => r.seconds)),
  mean_cost: Math.round(mean(rows.map((r) => r.cost)) * 10_000) / 10_000,
});

const study: Record<string, Group[]> = {};
for (const exam of ["exam", "heldout"]) {
  const run = newest("routed", exam);
  if (!run) continue;
  const rows = rowsOf(run);
  study[`${exam === "exam" ? "main exam" : "held-out set"}, full system (${run.file})`] = [
    summarise(
      "answered by Nemotron 3 Ultra (cloud)",
      rows.filter((r) => r.served === "ultra"),
    ),
    summarise(
      "answered by Nemotron 3.5 Lightning (local)",
      rows.filter((r) => r.served === "lightning"),
    ),
  ];
  const lightning = newest("lightning", exam);
  if (lightning) {
    study[
      `${exam === "exam" ? "main exam" : "held-out set"}, extra run: all reasoning steps on Lightning (${lightning.file})`
    ] = [summarise("answered by Nemotron 3.5 Lightning (local), every step", rowsOf(lightning))];
  }
}
writeFileSync(resolveProjectPath("eval/model-study.json"), `${JSON.stringify(study, null, 2)}\n`);

const lines = [
  "## Which Nemotron model does what, and why",
  "",
  "The decision step is answered by whichever Nemotron model the Nightshift router picks for the call (Nemotron 3 Ultra 550B in the cloud, or Nemotron 3.5 Lightning 30B on a local laptop); the safety guard is bound to the local model in the cockpit. The comparison below groups each case by the model that answered its final decision call, from the sealed records. **The router, not this study, chooses the model, so the groups are not a controlled experiment**: if harder cases go to one model more often, the groups differ for that reason too. A group with few cases says little.",
  "",
];
for (const [title, groups] of Object.entries(study)) {
  lines.push(
    `### ${title}`,
    "",
    "| Decision answered by | Cases | Exact | Acceptable | False closes | Wrong citations caught | Median s | Mean cost |",
    "|---|--:|--:|--:|--:|--:|--:|--:|",
  );
  for (const g of groups)
    lines.push(
      `| ${g.group} | ${g.cases} | ${g.exact} | ${g.acceptable} | ${g.false_closes} | ${g.citation_catches} | ${g.median_seconds.toFixed(0)} | ${g.mean_cost.toFixed(4)} ${config.costs.currency} |`,
    );
  lines.push("");
}
if (Object.keys(study).length === 0) lines.push("No complete full-system run is saved yet.", "");
writeFileSync(resolveProjectPath("eval/MODEL-STUDY.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));

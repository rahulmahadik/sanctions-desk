/**
 * Build eval/REPORT.md from the saved exam results (newest result of each variant). Nothing here is typed in
 * by hand: every number comes from a results file written by `npm run exam`.
 *
 *   npm run exam:report
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Metrics, ScoredCase } from "@sanctions-desk/agents";
import { resolveProjectPath } from "@sanctions-desk/shared";

interface Result {
  variant: string;
  started_at: string;
  policy_version: number;
  models: Record<string, string>;
  cases: ScoredCase[];
  metrics: Metrics;
}

const dir = resolveProjectPath("eval/results");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const newest = new Map<string, Result>();
for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Result;
  newest.set(r.variant, r);
}

const ORDER = ["routed", "single", "local", "rules", "no_memory", "fuzzy", "escalate_all"];
const LABEL: Record<string, string> = {
  routed: "Full system, routed across the model lanes",
  single: "One recommendation, no critic, no memory",
  local: "Full system, local lane only, reasoning off",
  rules: "Labelled rules model instead of a language model",
  no_memory: "Full system with memory off (earlier-cleared cases only)",
  fuzzy: "Baseline: name score threshold 0.90, no model",
  escalate_all: "Baseline: every alert goes to a person",
};
const variants = ORDER.filter((v) => newest.has(v)).map((v) => newest.get(v) as Result);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const lines: string[] = [];
lines.push("# Exam report", "");
lines.push(
  "Every number below was produced by `npm run exam` on this machine and is read from `eval/results/*.json`.",
  "Nothing is edited by hand. Rebuild this file with `npm run exam:report`.",
  "",
  "The exam has 60 cases built from real public list entries and synthetic customers, payments and owners: 58 alerts and 2 drafts that must not tip a customer off. Each case has one right answer, some acceptable alternatives, and answers that must never be given. A case carries real risk when closing it would be wrong; the **false-close rate** is the share of those cases the system recommended closing. The target is 0.",
  "",
);
if (variants.length === 0) {
  lines.push("_No results have been saved yet._", "");
} else {
  lines.push("## Summary", "");
  lines.push(
    "| Variant | Cases | Exact | Acceptable | False closes (risk cases) | Abstain | Mean s | p95 s | Cloud share | Cost per case | Errors |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of variants) {
    const m = r.metrics;
    lines.push(
      `| ${LABEL[r.variant] ?? r.variant} | ${m.cases} | ${pct(m.exact_accuracy)} | ${pct(m.acceptable_accuracy)} | ${m.false_closes} of ${m.risk_cases} (${pct(m.false_close_rate)}) | ${pct(m.abstain_rate)} | ${m.latency_s.mean} | ${m.latency_s.p95} | ${pct(m.model_calls.cloud_share)} | ${m.cost.per_case.toFixed(6)} | ${m.errors} |`,
    );
  }
  lines.push(
    "",
    "Cost uses the illustrative unit costs in `config/default.json` (`costs`); they are assumptions, not prices. Local model calls and saved sample answers cost nothing.",
    "",
  );

  lines.push("## Accuracy by group", "");
  const groups = [...new Set(variants.flatMap((r) => Object.keys(r.metrics.by_group)))];
  lines.push(
    `| Group | ${variants.map((r) => r.variant).join(" | ")} |`,
    `|---|${variants.map(() => "---:").join("|")}|`,
  );
  for (const g of groups) {
    const cells = variants.map((r) => {
      const x = r.metrics.by_group[g];
      return x ? `${x.acceptable}/${x.cases}` : "-";
    });
    lines.push(`| ${g} | ${cells.join(" | ")} |`);
  }
  lines.push("", "Cells show cases answered acceptably out of cases run.", "");

  for (const r of variants.filter((v) => ["routed", "single", "local", "rules"].includes(v.variant))) {
    const misses = r.cases.filter((c) => c.got !== c.expected && !c.acceptable.includes(c.got));
    lines.push(`## Misses: ${r.variant}`, "");
    if (misses.length === 0) lines.push("None.", "");
    else {
      lines.push("| Case | Kind | Expected | Got | Note |", "|---|---|---|---|---|");
      for (const c of misses)
        lines.push(
          `| ${c.case_id} | ${c.kind} | ${c.expected} | ${c.got} | ${c.error ?? (c.must_not.includes(c.got) ? "forbidden answer" : "")} |`,
        );
      lines.push("");
    }
  }

  const full = newest.get("routed");
  if (full) {
    lines.push("## The full system in detail", "");
    lines.push(`Policy version ${full.policy_version}. Models per step:`, "");
    for (const [agent, model] of Object.entries(full.models)) lines.push(`- ${agent}: ${model}`);
    const m = full.metrics;
    lines.push(
      "",
      `- Model calls: ${m.model_calls.local} local, ${m.model_calls.cloud} cloud; tokens ${m.tokens.in} in / ${m.tokens.out} out.`,
      `- Critic: ${m.critic.reviewed} reviews, ${m.critic.sent_back} sent back at least once, ${m.critic.unresolved} unresolved after the allowed rounds (mean ${m.critic.mean_rounds} rounds).`,
      `- Forbidden answers: ${m.forbidden_answers}.`,
      "",
    );
  }
  const withMemory = newest.get("routed");
  const withoutMemory = newest.get("no_memory");
  if (withMemory && withoutMemory) {
    const cleared = withMemory.cases.filter((c) => c.group.startsWith("previously_cleared"));
    const mean = (xs: ScoredCase[]) =>
      xs.length === 0 ? 0 : xs.reduce((t, c) => t + (c.latency_s ?? 0), 0) / xs.length;
    lines.push(
      "## Effect of memory",
      "",
      `On the ${cleared.length} earlier-cleared cases: mean ${mean(cleared).toFixed(1)} s with memory, ${mean(withoutMemory.cases).toFixed(1)} s without. Acceptable answers: ${cleared.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length} with memory, ${withoutMemory.cases.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length} without.`,
      "",
    );
  }
}
lines.push(
  "## Limits of this exam",
  "",
  "- The customers, payments and owners are synthetic; the listed parties are real public entries. The exam shows how the system behaves on planted situations, not how it would perform on a bank's real alert volume.",
  "- Cases were written together with the rules they test (the approved definitions), so a high score shows consistency with those definitions rather than proof that the definitions are right.",
  "- Latency depends on this machine, on whether the cloud lane answers within the runtime's time limit, and on what else is running.",
  "- Model answers can vary between runs; each variant's file records the run it came from.",
  "",
);
writeFileSync(resolveProjectPath("eval/REPORT.md"), `${lines.join("\n")}\n`);
console.log(`wrote eval/REPORT.md from ${variants.length} variant(s)`);

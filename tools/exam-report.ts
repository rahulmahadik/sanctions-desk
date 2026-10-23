/**
 * Build eval/REPORT.md, and the headline block in README.md, from the saved exam results (the newest complete run
 * of each variant). Nothing here is typed in by hand: every number comes from a results file written by
 * `npm run exam`, apart from the minutes-saved figure, which rests on the assumptions in `config/default.json`
 * (`report`) and says so.
 *
 *   npm run exam:report
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Headline, headlineOf, headlineSentence, type Metrics, type ScoredCase } from "@sanctions-desk/agents";
import { loadExam } from "@sanctions-desk/data";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";

interface Result {
  variant: string;
  tag?: string;
  selection?: { groups?: string[]; kinds?: number; limit?: number };
  started_at: string;
  policy_version: number;
  models: Record<string, string>;
  cases: ScoredCase[];
  metrics: Metrics;
}

const dir = resolveProjectPath("eval/results");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.startsWith("bench-"))
  .sort();
const newest = new Map<string, Result & { file: string }>();
for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Result;
  const partial = r.tag !== undefined || r.selection?.kinds || r.selection?.groups || r.selection?.limit;
  if (!partial) newest.set(r.variant, { ...r, file: f });
}

const config = loadConfig();
const assumptions = config.report;
const exam = loadExam();
const alertCases = exam.cases.filter((c) => c.alert_id !== null).length;
const draftCases = exam.cases.length - alertCases;

const ORDER = ["routed", "single", "no_memory", "local", "rules", "fuzzy", "escalate_all"];
const LABEL: Record<string, string> = {
  routed: "Full system (routed across the model lanes, critic, challenger, memory)",
  single: "Single recommendation (no critic, no challenger, no memory)",
  no_memory: "Full system with memory off (earlier-cleared cases only)",
  local: "Full system, local lane only, reasoning off",
  rules: "Deterministic pipeline (our own matching, ownership and policy code; no language model)",
  fuzzy: "Name-match rules baseline (name score at or above 0.90 escalates, below closes)",
  escalate_all: "Baseline: every alert goes to a person",
};
const have = ORDER.filter((v) => newest.has(v));
const notRun = ORDER.filter((v) => !newest.has(v));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pct0 = (n: number) => `${(n * 100).toFixed(0)}%`;
const get = (v: string) => newest.get(v);

const lines: string[] = [];
const full = get("routed");
const head: Headline | undefined = full ? headlineOf(full.cases, assumptions) : undefined;

lines.push("# Exam report", "");
lines.push("## Headline", "");
if (head && full) {
  lines.push(
    `Measured on the full system (${full.variant}, ${head.alerts} alert cases, run started ${full.started_at}):`,
    "",
    `- **Closed with cited evidence:** ${head.closed_with_evidence} of ${head.alerts} alerts (${pct0(head.closed_share)}); ${head.closed_correctly} of them rightly. A person still confirms each close, from the evidence the desk cites.`,
    `- **Escalated:** ${head.escalated} of ${head.alerts} alerts (${pct0(head.escalated_share)}), including ${head.decision_unavailable} escalated only because no model decision was usable.`,
    `- **False closes on cases that carry real risk:** ${head.false_closes} of ${head.risk_cases} (${pct(head.false_close_rate)}); on the ${head.true_match_cases} true matches: ${head.true_match_false_closes}. The target is 0.`,
    `- **Analyst minutes saved per 100 alerts: about ${head.minutes_saved_per_100_alerts.toFixed(0)}.** This one is an *estimate that rests on assumptions*, not a measurement: ${assumptions.minutesPerAlert} minutes for an analyst to work an alert from scratch, ${assumptions.minutesToConfirmClose} minutes to confirm a close from cited evidence, and no time credited for the alerts that are escalated. Only closes that were right count. Change the assumptions in \`config/default.json\` (\`report\`) and rebuild this file.`,
    "",
  );
} else {
  lines.push("_The full system has not been run yet, so there is no headline figure._", "");
}

lines.push(
  "Every number below was produced by `npm run exam` on this machine and is read from `eval/results/*.json`; rebuild this file with `npm run exam:report`.",
  "",
  "**Single run.** Each variant below is from one run. Model answers vary between runs, and the runtime may answer a repeated prompt from its cache, which makes time and cost look better than a cold run. Treat differences of a few cases as noise.",
  "",
  `The exam has ${exam.cases.length} cases built from real public list entries and synthetic customers, payments and owners: ${alertCases} alerts and ${draftCases} drafts that must not tip a customer off. Each case has one right answer, some acceptable alternatives, and answers that must never be given. A case carries real risk when closing it would be wrong; the **false-close rate** is the share of those cases the system recommended closing.`,
  "",
);

if (have.length === 0) {
  lines.push("_No results have been saved yet._", "");
} else {
  lines.push("## Variants compared", "");
  lines.push(
    "| Variant | Cases | Exact | Acceptable | Acceptable, leaving out unavailable decisions | False closes (risk cases) | No usable decision: provider / parsing | Median s | p95 s | Cloud share of calls | Model cost |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const v of have) {
    const r = get(v) as Result;
    const m = r.metrics;
    const x = m.excluding_unavailable;
    const by = m.decision_unavailable_by_cause;
    lines.push(
      `| ${LABEL[v] ?? v} | ${m.cases} | ${pct(m.exact_accuracy)} | ${pct(m.acceptable_accuracy)} | ${x ? `${pct(x.acceptable_accuracy)} (${x.cases} cases)` : "-"} | ${m.false_closes} of ${m.risk_cases} (${pct(m.false_close_rate)}) | ${by ? `${by.provider} / ${by.parsing}` : "-"} | ${m.latency_s.p50} | ${m.latency_s.p95} | ${pct(m.model_calls.cloud_share)} | ${m.cost.total.toFixed(4)} |`,
    );
  }
  lines.push(
    "",
    notRun.length > 0 ? `**Not run:** ${notRun.map((v) => LABEL[v] ?? v).join("; ")}.` : "",
    "",
    "- *Deterministic pipeline* is our own code (matching, ownership engine, policy guard) with a labelled rules stand-in in place of a language model. It is not typical screening: it reads the same evidence, so it shows what the code alone settles. *Name-match rules baseline* is typical screening: it sees only a name score, with no ownership, data-quality or evidence reasoning.",
    '- *No usable decision* counts the cases where the decision step got no usable model answer and the desk escalated them with the reason "model decision unavailable". **Provider** means the model service failed or answered with nothing; **parsing** means it answered in a form that could not be used. They are in the totals; the next column leaves them out.',
    `- Model cost uses the illustrative unit costs in \`config/default.json\` (\`costs\`, currency ${config.costs.currency}); they are assumptions, not prices. Calls on the local lane run on this machine and cost nothing per call; only cloud tokens are priced.`,
    "",
  );

  const fuzzy = get("fuzzy");
  if (fuzzy && fuzzy.cases.every((c) => c.score !== undefined || c.got === "DRAFT_ALLOWED")) {
    lines.push("### The name-match rules baseline at other thresholds", "");
    lines.push("| Threshold | Acceptable | False closes (risk cases) | Escalated |", "|---:|---:|---:|---:|");
    for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
      const cases = fuzzy.cases.map((c) =>
        c.score === undefined ? c : { ...c, got: c.score >= t ? "ESCALATE_L2" : "CLOSE_FALSE_POSITIVE" },
      );
      const h = headlineOf(cases, assumptions);
      const ok = cases.filter((c) => c.got === c.expected || c.acceptable.includes(c.got)).length;
      lines.push(
        `| ${t.toFixed(2)} | ${pct(ok / cases.length)} | ${h.false_closes} of ${h.risk_cases} | ${h.escalated} of ${h.alerts} |`,
      );
    }
    lines.push(
      "",
      "Moving the line changes how many alerts go to a person, and the false closes are the risk cases that score below it.",
      "",
    );
  }

  lines.push("## Accuracy by group", "");
  const groups = [...new Set(have.flatMap((v) => Object.keys((get(v) as Result).metrics.by_group)))];
  lines.push(`| Group | ${have.join(" | ")} |`, `|---|${have.map(() => "---:").join("|")}|`);
  for (const g of groups) {
    lines.push(
      `| ${g} | ${have
        .map((v) => {
          const x = (get(v) as Result).metrics.by_group[g];
          return x ? `${x.acceptable}/${x.cases}` : "-";
        })
        .join(" | ")} |`,
    );
  }
  lines.push("", "Cells show cases answered acceptably out of cases run.", "");

  for (const v of ["routed", "single", "local", "rules"].filter((x) => newest.has(x))) {
    const r = get(v) as Result;
    const misses = r.cases.filter((c) => c.got !== c.expected && !c.acceptable.includes(c.got));
    lines.push(`## Misses: ${v}`, "");
    if (misses.length === 0) lines.push("None.", "");
    else {
      lines.push("| Case | Kind | Expected | Got | Note |", "|---|---|---|---|---|");
      for (const c of misses) {
        const note =
          c.error ??
          (c.must_not.includes(c.got)
            ? "forbidden answer"
            : c.decision_unavailable
              ? `no usable model decision (${c.decision_unavailable})`
              : "");
        lines.push(`| ${c.case_id} | ${c.kind} | ${c.expected} | ${c.got} | ${note} |`);
      }
      lines.push("");
    }
  }

  if (full) {
    const m = full.metrics;
    lines.push(
      "## The full system in detail",
      "",
      `Policy version ${full.policy_version}. Model and reasoning setting per step:`,
      "",
    );
    for (const [agent, model] of Object.entries(full.models)) lines.push(`- ${agent}: ${model}`);
    lines.push(
      "",
      `- **Model calls:** ${m.model_calls.local} on the local lane (no API cost), ${m.model_calls.cloud} on the cloud lane; ${m.tokens.in} tokens in and ${m.tokens.out} out.`,
      `- **Cost of the run:** ${m.cost.total.toFixed(4)} ${config.costs.currency} under the assumed cloud rates (${m.cost.per_case.toFixed(4)} per case); the local calls add nothing.`,
      `- **Time:** median ${m.latency_s.p50} s and p95 ${m.latency_s.p95} s per case, mean ${m.latency_s.mean} s.`,
      `- **Critic:** ${m.critic.reviewed} reviews, ${m.critic.sent_back} sent back at least once, ${m.critic.unresolved} unresolved after the allowed rounds (mean ${m.critic.mean_rounds} rounds).`,
      `- **Forbidden answers:** ${m.forbidden_answers}.`,
      "",
    );
    const ch = m.challenger;
    if (ch) {
      lines.push(
        "### The challenger",
        "",
        `It looks at a close only when confidence is below the policy line, the name is very close, or a data-quality rule fails. In this run it looked at ${ch.fired} closes and turned ${ch.changed} of them into an escalation (a credible true-match argument, or no answer from the challenger). It added ${ch.added_seconds.toFixed(0)} s of model time and ${ch.added_cost.toFixed(4)} ${config.costs.currency} in total.`,
        "",
      );
    }
  }

  const rate = join(resolveProjectPath("eval"), "json-failure-rate.json");
  if (existsSync(rate)) {
    const j = JSON.parse(readFileSync(rate, "utf8")) as {
      note: string;
      before: Array<{ step: string; attempts: number; unusable: number }>;
      after: Array<{ step: string; attempts: number; unusable: number }>;
    };
    lines.push("## How often a model answer could not be used as JSON", "", j.note, "");
    lines.push(
      "| Step | Before: attempts | Before: unusable | After: attempts | After: unusable |",
      "|---|---:|---:|---:|---:|",
    );
    for (const b of j.before) {
      const a = j.after.find((x) => x.step === b.step);
      const f = (x: { attempts: number; unusable: number } | undefined) =>
        x ? `${x.attempts} | ${x.unusable} (${pct(x.unusable / Math.max(1, x.attempts))})` : "- | -";
      lines.push(`| ${b.step} | ${f(b)} | ${f(a)} |`);
    }
    lines.push("");
  }

  const withMemory = get("routed");
  const withoutMemory = get("no_memory");
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
  "- Cases were written together with the rules they test (the approved definitions), so a high score shows consistency with those definitions rather than proof that the definitions are right. Five cases were added later to test where plain name matching fails; the system was not tuned to them.",
  "- Time depends on this machine, on whether the cloud lane answers within the runtime's time limit, on what else is running, and on the runtime's answer cache.",
  "- Each variant is one run; the file of that run is named in `eval/results/`.",
  "",
);
writeFileSync(resolveProjectPath("eval/REPORT.md"), `${lines.join("\n")}\n`);

// The README carries the same headline between two markers.
const readmePath = resolveProjectPath("README.md");
const readme = readFileSync(readmePath, "utf8");
const START = "<!-- headline:start -->";
const END = "<!-- headline:end -->";
if (head && full && readme.includes(START) && readme.includes(END)) {
  const block = [
    START,
    `**Headline result** (full system on the ${head.alerts}-alert exam, one run): ${headlineSentence(head)} Details, assumptions and the comparison with plain name matching: [eval/REPORT.md](eval/REPORT.md).`,
    END,
  ].join("\n");
  writeFileSync(readmePath, readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block));
}
console.log(
  `wrote eval/REPORT.md from ${have.length} variant(s)${notRun.length ? `; not run: ${notRun.join(", ")}` : ""}`,
);

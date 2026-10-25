/**
 * Small study, 12 cases x 3 runs, not part of the recorded evaluation: held-out v4 run three times by the full system
 * (privacy mode off) and three times by the "Nemotron alone" baseline (one cloud Ultra call per case on the structured
 * case facts). Per system: wrong closes, clears, acceptable outcomes, escalated share, and how often the three runs
 * agree on a case. Calibration: the Brier score of the confidence given to the chosen outcome, one-vs-rest (1 when the
 * chosen outcome is acceptable for the case, else 0), for these runs and the other labelled runs of 24 Oct 2026 that
 * recorded a confidence; baselines without a real confidence are marked n/a.
 *
 *   npm run study:repeat              # writes eval/repeat-study.json and the block in docs/NEMOTRON.md
 *   npm run study:repeat -- --check
 *
 * It reads result files in logs/repeat, logs/privacy-test and logs/model-choice and, for runs whose result files carry
 * no confidence, the sealed records in logs/records (all kept on this machine). Without them (a fresh clone) the
 * committed eval/repeat-study.json is used as it is.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countWithInterval, resolveProjectPath, wilson95 } from "@sanctions-desk/shared";
import { formatMarkdown } from "./lib/format-markdown.js";

interface Case {
  case_id: string;
  expected: string;
  acceptable: string[];
  must_not: string[];
  got: string;
  confidence?: number;
  /** Full system: why no model decision was usable, when none was (the case is then escalated to a person). */
  decision_unavailable?: string;
}
interface Result {
  variant: string;
  exam?: string;
  system?: string;
  run?: string;
  cases: Case[];
}
interface RunSummary {
  run: string;
  wrong_closes: number;
  risk_cases: number;
  clears_made: number;
  clear_cases: number;
  acceptable: number;
  cases: number;
  escalated_share: number;
  errors: number;
  /** Cases without a usable model answer: an error, or (full system) escalated because no model decision was usable. */
  no_usable_answer?: number;
  /** Risk cases among them. */
  risk_without_answer?: number;
}
interface SystemSummary {
  system: string;
  runs: RunSummary[];
  /** Cases on which all runs gave the same outcome. */
  all_runs_agree: number;
  cases: number;
}
interface Calibration {
  label: string;
  cases_with_confidence: number;
  brier: number | null;
}

const check = process.argv.includes("--check");
const outFile = resolveProjectPath("eval/repeat-study.json");
const logs = resolveProjectPath("logs");
const read = (dir: string, match: (f: string) => boolean): Array<Result & { file: string }> => {
  const d = join(logs, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && match(f))
    .sort()
    .map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(d, f), "utf8")) as Result) }))
    .filter((r) => Array.isArray(r.cases));
};
const noAnswer = (c: Case) => c.got === "ERROR" || c.decision_unavailable !== undefined;
const ok = (c: Case) => c.got === c.expected || c.acceptable.includes(c.got);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function runSummary(run: string, r: Result): RunSummary {
  const risk = r.cases.filter((c) => c.must_not.includes("CLOSE_FALSE_POSITIVE"));
  const clear = r.cases.filter((c) => c.expected === "CLOSE_FALSE_POSITIVE");
  return {
    run,
    wrong_closes: risk.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length,
    risk_cases: risk.length,
    clears_made: clear.filter((c) => c.got === "CLOSE_FALSE_POSITIVE").length,
    clear_cases: clear.length,
    acceptable: r.cases.filter(ok).length,
    cases: r.cases.length,
    escalated_share: round3(r.cases.filter((c) => c.got === "ESCALATE_L2").length / Math.max(r.cases.length, 1)),
    errors: r.cases.filter((c) => c.got === "ERROR").length,
    no_usable_answer: r.cases.filter(noAnswer).length,
    risk_without_answer: risk.filter(noAnswer).length,
  };
}

function systemSummary(system: string, runs: Array<[string, Result]>): SystemSummary {
  const ids = [...new Set(runs.flatMap(([, r]) => r.cases.map((c) => c.case_id)))];
  const agree = ids.filter((id) => {
    const outs = runs.map(([, r]) => r.cases.find((c) => c.case_id === id)?.got);
    return outs.every((o) => o !== undefined && o === outs[0]);
  }).length;
  return { system, runs: runs.map(([name, r]) => runSummary(name, r)), all_runs_agree: agree, cases: ids.length };
}

/** The confidence of each case: from the result file, or from the case's sealed record in logs/records. */
function withConfidence(r: Result, runPrefix: string): Case[] {
  return r.cases.map((c) => {
    if (c.confidence !== undefined) return c;
    const file = join(logs, "records", `rec-${runPrefix}-${r.variant}-${c.case_id}.json`);
    if (!existsSync(file)) return c;
    const rec = JSON.parse(readFileSync(file, "utf8")) as { confidence?: number };
    return rec.confidence === undefined ? c : { ...c, confidence: rec.confidence };
  });
}

function brier(label: string, cases: Case[]): Calibration {
  const scored = cases.filter((c) => typeof c.confidence === "number" && c.got !== "ERROR");
  if (scored.length === 0) return { label, cases_with_confidence: 0, brier: null };
  const b = scored.reduce((t, c) => t + ((c.confidence as number) - (ok(c) ? 1 : 0)) ** 2, 0) / scored.length;
  return { label, cases_with_confidence: scored.length, brier: round3(b) };
}

const full = read("repeat", (f) => /-heldout4-repr\d-routed\.json$/.test(f));
const alone = read("repeat", (f) => /-heldout4-r\d-nemotron_alone\.json$/.test(f));
// The fairer arm (25 Oct 2026): Nemotron alone given the same free text the screener reads, same prompt otherwise.
const aloneText = read("repeat", (f) => /-heldout4-text\d-nemotron_alone\.json$/.test(f));
let study:
  | {
      label: string;
      note: string;
      systems: SystemSummary[];
      calibration: Calibration[];
      brier_definition: string;
    }
  | undefined;
if (full.length > 0 && alone.length > 0) {
  const runName = (r: Result & { file: string }) => r.system?.replace(/^rep/, "") ?? r.run ?? r.file;
  const fullRuns = full.map(
    (r) => [runName(r), { ...r, cases: withConfidence(r, `eval-heldout4-${r.system}`) }] as [string, Result],
  );
  const aloneRuns = alone.map((r) => [r.run ?? r.file, r] as [string, Result]);
  const aloneTextRuns = aloneText.map((r) => [r.run ?? r.file, r] as [string, Result]);
  const labelled: Calibration[] = [];
  for (const [dir, system, label] of [
    ["privacy-test", "privoff", "Full system, privacy mode off (24 Oct, held-out v4 and 8 exam cases, one run)"],
    ["privacy-test", "privon", "Full system, privacy mode on (24 Oct, same 20 cases, one run)"],
    ["model-choice", "choice", "Reasoning on Lightning (24 Oct, same 20 cases, one run)"],
  ] as const) {
    const results = read(dir, (f) => f.includes(`-${system}-`));
    const cases = results.flatMap((r) => withConfidence(r, `${r.exam ? `eval-${r.exam}` : "eval"}-${r.system}`));
    if (cases.length > 0) labelled.push(brier(label, cases));
  }
  study = {
    label: "Small study, 12 cases x 3 runs, not part of the recorded evaluation",
    note: `Held-out v4 run three times by the full system (privacy mode off) and three times by Nemotron alone (one cloud Ultra call per case on the structured case facts the decision step gets: no free text, critic, challenger, policy guard or memory), 24-25 Oct 2026, after a warm-up and without restarting Nightshift.${aloneTextRuns.length > 0 ? " Added on 25 Oct 2026, a fairer arm: Nemotron alone given the same free text the screener reads (customer note, payment reference, list remarks), with the same prompt otherwise, three runs; the first Nemotron-alone arm is kept as it was." : ""}`,
    systems: [
      systemSummary("Full system", fullRuns),
      systemSummary("Nemotron alone, no free text", aloneRuns),
      ...(aloneTextRuns.length > 0 ? [systemSummary("Nemotron alone, with the free text", aloneTextRuns)] : []),
    ],
    calibration: [
      brier(
        "Full system (3 runs above)",
        fullRuns.flatMap(([, r]) => r.cases),
      ),
      brier(
        "Nemotron alone, no free text (3 runs above)",
        aloneRuns.flatMap(([, r]) => r.cases),
      ),
      ...(aloneTextRuns.length > 0
        ? [
            brier(
              "Nemotron alone, with the free text (3 runs above)",
              aloneTextRuns.flatMap(([, r]) => r.cases),
            ),
          ]
        : []),
      ...labelled,
      {
        label: "Deterministic rules, name match, escalate everything (no real confidence)",
        cases_with_confidence: 0,
        brier: null,
      },
    ],
    brier_definition:
      "Mean of (confidence - y) squared over cases, where y is 1 when the chosen outcome is acceptable for the case (its expected or an acceptable outcome) and 0 otherwise. 0 is perfect; always answering with confidence 0.5 scores 0.25. Lower is better.",
  };
} else if (existsSync(outFile)) {
  study = JSON.parse(readFileSync(outFile, "utf8"));
}
if (!study) throw new Error("no repeated runs found: run them first (see the header)");

const range = (xs: number[]) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? `${lo}` : `${lo} to ${hi}`;
};
const pct = (x: number) => Math.round(x * 100);
const table = [
  `**${study.label}.** ${study.note}`,
  "",
  `**1. Agreement between runs.** Same outcome in all ${study.systems[0]?.runs.length ?? 3} runs: ${study.systems.map((s) => `${s.system} on ${s.all_runs_agree} of ${s.cases} cases`).join("; ")}.`,
  "",
  "**2. Ranges across the runs** (lowest to highest of the three):",
  "",
  "| System | Risk cases wrongly closed | Clears made | Acceptable outcomes | Escalated share | Errors |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...study.systems.map((s) => {
    const r = s.runs;
    const of = (k: keyof RunSummary, n: keyof RunSummary) =>
      `${range(r.map((x) => x[k] as number))} of ${r[0]?.[n] ?? 0}`;
    return `| ${s.system} | ${of("wrong_closes", "risk_cases")} | ${of("clears_made", "clear_cases")} | ${of("acceptable", "cases")} | ${range(r.map((x) => pct(x.escalated_share)))}% | ${range(r.map((x) => x.errors))} |`;
  }),
  "",
  "Each run:",
  "",
  "| System | Run | Risk cases wrongly closed (95% range) | Clears made | Acceptable outcomes | Escalated share | Errors |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ...study.systems.flatMap((s) =>
    s.runs.map(
      (r) =>
        `| ${s.system} | ${r.run} | ${countWithInterval(r.wrong_closes, r.risk_cases)} | ${r.clears_made} of ${r.clear_cases} | ${r.acceptable} of ${r.cases} | ${pct(r.escalated_share)}% | ${r.errors} |`,
    ),
  ),
  "",
  "Ranges use the Wilson score method.",
  "",
  "**3. Calibration** (Brier score, lower is better; with this few cases it is indicative only, and a difference of a few hundredths is not read as one system being better calibrated):",
  "",
  "| Runs | Cases with a confidence (n) | Brier score |",
  "| --- | ---: | ---: |",
  ...study.calibration.map(
    (c) => `| ${c.label} | ${c.cases_with_confidence} | ${c.brier === null ? "n/a" : c.brier} |`,
  ),
  "",
  `Brier score: ${study.brier_definition}`,
].join("\n");

// Nemotron alone, once, on held-out v1 and v3 (the rounds where the full system closed risk cases), beside the
// recorded runs of the same frozen sets. Read from logs/alone-v1v3 when present, else from the committed summary.
interface SetRow {
  set: string;
  system: string;
  source: string;
  summary: RunSummary;
}
const setsFile = resolveProjectPath("eval/nemotron-alone-sets.json");
const recordedResult = (file: string): Result =>
  JSON.parse(readFileSync(resolveProjectPath(`eval/results/${file}`), "utf8")) as Result;
const SETS = [
  {
    set: "Held-out v1 (30 cases)",
    exam: "heldout",
    recorded: [
      ["Full system, first system (no screener)", "2026-10-23T12-11-40-825Z-heldout-routed.json"],
      [
        "Full system after the screener was added (re-run, not blind)",
        "2026-10-23T21-45-15-877Z-heldout-sys2b-routed.json",
      ],
      ["Deterministic rules", "2026-10-23T08-13-08-222Z-heldout-rules.json"],
    ],
  },
  {
    set: "Held-out v3 (12 cases)",
    exam: "heldout3",
    recorded: [
      ["Full system (span grounding)", "2026-10-23T23-19-01-303Z-heldout3-sys3-routed.json"],
      ["Deterministic rules", "2026-10-23T23-41-47-213Z-heldout3-rules.json"],
    ],
  },
] as const;
let sets: { label: string; note: string; rows: SetRow[] } | undefined;
const aloneSets = SETS.map((s) => ({
  s,
  r: read("alone-v1v3", (f) => f.includes(`-${s.exam}-once-nemotron_alone`)).at(-1),
}));
if (aloneSets.every(({ r }) => r)) {
  sets = {
    label: "Small study, one run per set, not part of the recorded evaluation",
    note: "Nemotron alone (one cloud Ultra call per case on the structured case facts, as above) once on held-out v1 and v3, the two rounds where the full system wrongly closed risk cases, 25 Oct 2026, after a warm-up and without restarting Nightshift; beside the recorded runs of the same frozen sets (one run each, 23 Oct 2026).",
    rows: aloneSets.flatMap(({ s, r }) => [
      {
        set: s.set,
        system: "Nemotron alone",
        source: `logs/alone-v1v3/${r?.file}`,
        summary: runSummary("once", r as Result),
      },
      ...s.recorded.map(([system, file]) => ({
        set: s.set,
        system,
        source: `eval/results/${file}`,
        summary: runSummary("recorded", recordedResult(file)),
      })),
    ]),
  };
} else if (existsSync(setsFile)) {
  sets = JSON.parse(readFileSync(setsFile, "utf8"));
}
const setsTable = sets
  ? [
      `**${sets.label}.** ${sets.note}`,
      "",
      "| Set | System | Risk cases wrongly closed | Clears made | Acceptable outcomes | Errors | Result file |",
      "| --- | --- | ---: | ---: | ---: | ---: | --- |",
      ...sets.rows.map(
        (r) =>
          `| ${r.set} | ${r.system} | ${r.summary.wrong_closes} of ${r.summary.risk_cases} | ${r.summary.clears_made} of ${r.summary.clear_cases} | ${r.summary.acceptable} of ${r.summary.cases} | ${r.summary.errors} | \`${r.source.split("/").at(-1)}\` |`,
      ),
    ].join("\n")
  : undefined;

// One generated sentence, both Nemotron-alone arms beside the full system, for the README, docs and results page.
/** "3–5" (or "3" when every run gave the same count). */
const span = (xs: number[]) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
};
const wilsonHigh = (x: number, n: number) => wilson95(x, n).high;
const [fullSys, aloneSys, aloneTextSys] = study.systems;
/** "3, 6 and 4" (or with the 95% range after each). */
const listOf = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));
const closes = (s: SystemSummary | undefined, ranges: boolean) =>
  listOf((s?.runs ?? []).map((r) => (ranges ? countWithInterval(r.wrong_closes, r.risk_cases) : `${r.wrong_closes}`)));
const clears = (s: SystemSummary | undefined) => {
  const xs = (s?.runs ?? []).map((r) => r.clears_made);
  return xs.length > 1 && xs.every((x) => x === xs[0]) ? `${xs[0]} in each run` : listOf(xs.map(String));
};
const missing = (s: SystemSummary | undefined) =>
  `${span((s?.runs ?? []).map((r) => r.no_usable_answer ?? r.errors))} of ${s?.runs[0]?.cases ?? 0} cases per run, ${span((s?.runs ?? []).map((r) => r.risk_without_answer ?? 0))} of them among the ${s?.runs[0]?.risk_cases ?? 0} risk cases`;
function aloneHeadline(ranges: boolean): string {
  if (!fullSys || !aloneSys) return "";
  const n = fullSys.runs.length;
  const fullMissing = fullSys.runs.filter((r) => (r.no_usable_answer ?? 0) > 0);
  const allZero = fullSys.runs.every((r) => r.wrong_closes === 0);
  const full = `Full system: a checked recommendation on every case, raw text kept local, ${allZero ? `0 of ${fullSys.runs[0]?.risk_cases ?? 0} risk cases wrongly closed in each of ${n} runs${ranges ? ` (0–${wilsonHigh(0, fullSys.runs[0]?.risk_cases ?? 0)}% each)` : ""}` : `${closes(fullSys, ranges)} risk cases wrongly closed in its ${n} runs`}${fullMissing.length > 0 ? `; in ${fullMissing.length} of ${n} runs, ${listOf(fullMissing.map((r) => `${r.no_usable_answer}`))} case${fullMissing.length === 1 && fullMissing[0]?.no_usable_answer === 1 ? "" : "s"} had no usable model answer and ${fullMissing.length === 1 && fullMissing[0]?.no_usable_answer === 1 ? "was" : "were"} escalated to a person` : ""}.`;
  const alone = `Nemotron alone without the free text: ${closes(aloneSys, ranges)} wrongly closed, with no usable answer on ${missing(aloneSys)}.`;
  const text = aloneTextSys
    ? ` Nemotron alone with the free text sent to the cloud: ${closes(aloneTextSys, ranges)} wrongly closed, but no usable answer on ${missing(aloneTextSys)}. Nemotron alone cleared more: ${clears(aloneTextSys)} of ${aloneTextSys.runs[0]?.clear_cases ?? 0} clear cases with the free text (${clears(aloneSys)} without it), against ${clears(fullSys)} for the full system.`
    : "";
  return `${full} ${alone}${text}`;
}
const aloneSummary = `- **Small study, held-out v4, 12 cases, three runs each, not part of the recorded evaluation (written by \`npm run study:repeat\` from the study files; 95% ranges in brackets):** ${aloneHeadline(true)} Every v4 risk is stated only in free text, which the local screener reads. Details: [docs/NEMOTRON.md](${"DOCS"}NEMOTRON.md#what-the-agents-add-over-nemotron-alone).`;
const aloneHeadlineBlock = `**Measured against Nemotron alone** (small study, held-out v4, 12 cases, three runs each, not part of the recorded evaluation): ${aloneHeadline(false)}`;

const json = `${JSON.stringify(study, null, 2)}\n`;
let changed = !existsSync(outFile) || readFileSync(outFile, "utf8") !== json;
if (changed && !check) writeFileSync(outFile, json);
if (sets) {
  const setsJson = `${JSON.stringify(sets, null, 2)}\n`;
  if (!existsSync(setsFile) || readFileSync(setsFile, "utf8") !== setsJson) {
    changed = true;
    if (!check) writeFileSync(setsFile, setsJson);
  }
}
for (const path of ["README.md", "docs/NEMOTRON.md", "docs/SPONSORS.md"]) {
  const target = resolveProjectPath(path);
  const doc = readFileSync(target, "utf8");
  const reHeadline = /<!-- alone-headline:start -->[\s\S]*?<!-- alone-headline:end -->/;
  if (!reHeadline.test(doc)) continue;
  const lead = path === "README.md" ? "- " : "";
  const next = doc.replace(
    reHeadline,
    () => `<!-- alone-headline:start -->\n${lead}${aloneHeadlineBlock}\n<!-- alone-headline:end -->`,
  );
  if (next !== doc) {
    changed = true;
    if (!check) writeFileSync(target, next);
  }
}
for (const [path, docs] of [
  ["README.md", "docs/"],
  ["docs/EVALUATION.md", ""],
] as const) {
  const target = resolveProjectPath(path);
  const doc = readFileSync(target, "utf8");
  const reSummary = /<!-- alone-summary:start -->[\s\S]*?<!-- alone-summary:end -->/;
  if (!reSummary.test(doc)) continue;
  const next = doc.replace(
    reSummary,
    () => `<!-- alone-summary:start -->\n${aloneSummary.replace("DOCS", docs)}\n<!-- alone-summary:end -->`,
  );
  if (next !== doc) {
    changed = true;
    if (!check) writeFileSync(target, next);
  }
}
const docFile = resolveProjectPath("docs/NEMOTRON.md");
if (existsSync(docFile)) {
  const doc = readFileSync(docFile, "utf8");
  const re = /(<!-- repeat-study:start -->)[\s\S]*?(<!-- repeat-study:end -->)/;
  const reSets = /(<!-- alone-sets:start -->)[\s\S]*?(<!-- alone-sets:end -->)/;
  if (re.test(doc)) {
    const withSets =
      setsTable && reSets.test(doc)
        ? doc.replace(reSets, () => `<!-- alone-sets:start -->\n${setsTable}\n<!-- alone-sets:end -->`)
        : doc;
    const next = formatMarkdown(withSets.replace(re, `$1\n${table}\n$2`), docFile);
    if (next !== doc) {
      changed = true;
      if (!check) writeFileSync(docFile, next);
    }
  }
}
// Held-out v3 three ways: Nemotron alone (once), the system recorded at the time (once, the headline), and today's
// system (policy 8, fail-closed) re-run three times after the fix, not blind. Read from logs/v3today when present.
interface V3Today {
  label: string;
  note: string;
  columns: Array<{ system: string; source: string; runs: RunSummary[] }>;
}
const v3File = resolveProjectPath("eval/v3-today.json");
const todayRuns = read("v3today", (f) => /-heldout3-todayt\d-routed\.json$/.test(f));
let v3: V3Today | undefined;
const aloneV3 = sets?.rows.find((r) => r.set.startsWith("Held-out v3") && r.system === "Nemotron alone");
const recordedV3 = sets?.rows.find((r) => r.set.startsWith("Held-out v3") && r.system.startsWith("Full system"));
if (todayRuns.length > 0 && aloneV3 && recordedV3) {
  v3 = {
    label: "Small study, not part of the recorded evaluation",
    note: "Held-out v3 (12 cases, 6 risks, 6 clears) three ways. The recorded result of the system at the time stays the headline; today's system (policy 8, fail-closed) was re-run three times after the fail-closed fix, which held-out v3 led to, so those runs are not blind. 25 Oct 2026, after a warm-up and without restarting Nightshift.",
    columns: [
      { system: "Nemotron alone (one run)", source: aloneV3.source, runs: [aloneV3.summary] },
      {
        system: "The system recorded at the time (one run, the headline)",
        source: recordedV3.source,
        runs: [recordedV3.summary],
      },
      {
        system: "Today's system, re-run after the fail-closed fix, not blind",
        source: "logs/v3today",
        runs: todayRuns.map((r) => runSummary(r.system?.replace(/^today/, "") ?? r.file, r)),
      },
    ],
  };
} else if (existsSync(v3File)) {
  v3 = JSON.parse(readFileSync(v3File, "utf8"));
}
const v3Table = v3
  ? [
      `**${v3.label}.** ${v3.note}`,
      "",
      "| Held-out v3 | Run | Risk cases wrongly closed | Clears made | Acceptable outcomes | Errors |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      ...v3.columns.flatMap((c) =>
        c.runs.map(
          (r) =>
            `| ${c.system} | ${r.run} | ${r.wrong_closes} of ${r.risk_cases} | ${r.clears_made} of ${r.clear_cases} | ${r.acceptable} of ${r.cases} | ${r.errors} |`,
        ),
      ),
    ].join("\n")
  : undefined;
if (v3) {
  const v3Json = `${JSON.stringify(v3, null, 2)}\n`;
  if (!existsSync(v3File) || readFileSync(v3File, "utf8") !== v3Json) {
    changed = true;
    if (!check) writeFileSync(v3File, v3Json);
  }
  for (const path of ["docs/NEMOTRON.md", "docs/EVALUATION.md"]) {
    const target = resolveProjectPath(path);
    const doc = readFileSync(target, "utf8");
    const reV3 = /<!-- v3-today:start -->[\s\S]*?<!-- v3-today:end -->/;
    if (!reV3.test(doc) || !v3Table) continue;
    const next = formatMarkdown(
      doc.replace(reV3, () => `<!-- v3-today:start -->\n${v3Table}\n<!-- v3-today:end -->`),
      target,
    );
    if (next !== doc) {
      changed = true;
      if (!check) writeFileSync(target, next);
    }
  }
}
if (check && changed) {
  console.error("the repeat study summary is out of date: run npm run study:repeat");
  process.exit(1);
}
console.log(
  `${check ? "checked" : "wrote"} the repeat study (${study.systems.map((s) => `${s.system}: ${s.runs.length} runs`).join(", ")})`,
);

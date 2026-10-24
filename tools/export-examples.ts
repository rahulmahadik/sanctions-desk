/**
 * Turn real runs into the example files in output_examples/: the sealed decision record, the decision trace,
 * the run events, and a short case file a reader can follow without running anything. Nothing is written by
 * hand: every number and sentence in a case file comes from the saved run.
 *
 *   npm run examples -- --variant routed --case EX-001:clear-close --case EX-035:hidden-owner ...
 *   npm run examples -- --exam heldout --variant routed --case HO-019:held-out-clear
 *   npm run examples -- --exam heldout3 --system sys3 --variant routed --case HO3-007:v3-clear
 *   npm run examples -- --replay list-change-reopen        (runs the list-change replay against the live layer)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildTraceContract,
  readDecisionRecords,
  renderCaseFile,
  renderReplayFile,
  replayListChange,
  sampleRules,
} from "@sanctions-desk/agents";
import {
  HELDOUT_EXAM_FILE,
  HELDOUT2_EXAM_FILE,
  HELDOUT3_EXAM_FILE,
  HELDOUT4_EXAM_FILE,
  loadExam,
  MAIN_EXAM_FILE,
} from "@sanctions-desk/data";
import {
  createFallbackRulesGenerator,
  createTraceLogger,
  loadConfig,
  loadPolicyFile,
  resolveProjectPath,
  type TraceEvent,
} from "@sanctions-desk/shared";
import { createZetarisClient } from "@sanctions-desk/zetaris";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const values = (flag: string): string[] =>
  args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1] as string] : []));
const variant = values("--variant")[0] ?? "routed";
// --exam heldout|heldout2|heldout3|heldout4 reads the cases and runs of a held-out set; --system names the system version the
// runs were made with (their run ids carry it).
const examName = values("--exam")[0] ?? "exam";
const system = values("--system")[0];
const EXAM_FILES: Record<string, string> = {
  exam: MAIN_EXAM_FILE,
  heldout: HELDOUT_EXAM_FILE,
  heldout2: HELDOUT2_EXAM_FILE,
  heldout3: HELDOUT3_EXAM_FILE,
  heldout4: HELDOUT4_EXAM_FILE,
};
if (!EXAM_FILES[examName]) throw new Error("--exam must be exam, heldout, heldout2, heldout3 or heldout4");
const config = loadConfig();
const outRoot = resolveProjectPath("output_examples");

/** Where this repository sits on this machine: removed from every path in an example, so none names a local folder. */
const repoRoot = dirname(resolveProjectPath("package.json"));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.split(`${repoRoot}/`).join(""));
}

const exam = loadExam(EXAM_FILES[examName] as string);
for (const spec of values("--case")) {
  const [caseId, slug] = spec.split(":");
  const c = exam.cases.find((x) => x.case_id === caseId);
  if (!c || !slug)
    throw new Error(`use --case EX-001:short-name or HO-019:short-name with --exam heldout (got ${spec})`);
  const runId = `${examName === "exam" ? "eval" : `eval-${examName}`}${system ? `-${system}` : ""}-${variant}-${caseId}`;
  const [record] = readDecisionRecords(config.logging.dir, (r) => r.run_id === runId);
  if (!record) throw new Error(`no sealed record for ${runId}; run the exam variant first`);
  const traceFile = join(config.logging.dir, `trace-${runId}.jsonl`);
  const all = readFileSync(traceFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent);
  // The file holds every run of this case, each starting again at event 0. The sealed record is the newest run's.
  const start = all.map((e) => e.seq).lastIndexOf(0);
  const events = all
    .slice(Math.max(0, start))
    .filter((e) => e.ts <= new Date(Date.parse(record.decided_at) + 5000).toISOString());
  const contract = buildTraceContract(record, config.costs);
  const dir = join(outRoot, slug);
  write(join(dir, "decision-record.json"), `${JSON.stringify(record, null, 2)}\n`);
  write(join(dir, "decision-trace.json"), `${JSON.stringify(contract, null, 2)}\n`);
  write(join(dir, "run-events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  write(
    join(dir, "case.md"),
    renderCaseFile({
      title: c.title,
      summary: `${c.note} Exam case ${c.case_id} (${c.kind}); expected outcome: ${c.expected.replaceAll("_", " ").toLowerCase()}.`,
      record,
      events,
      contract,
      files: { record: "decision-record.json", trace: "decision-trace.json", events: "run-events.jsonl" },
    }),
  );
  console.log(`${slug}: ${record.decision} (${record.record_hash.slice(0, 12)})`);
}

for (const slug of values("--replay")) {
  const policy = loadPolicyFile(config.policy.file);
  const runId = `examples-${slug}`;
  const trace = createTraceLogger({ runId, dir: config.logging.dir, stdout: false, policyVersion: policy.version });
  const zetaris = createZetarisClient({ config });
  const report = await replayListChange(
    { config, policy, zetaris, generator: createFallbackRulesGenerator(sampleRules), trace, now: () => new Date() },
    {},
  );
  const dir = join(outRoot, slug);
  write(join(dir, "list-change-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  write(
    join(dir, "case.md"),
    renderReplayFile({
      title: "A list update re-opens earlier decisions",
      summary:
        "After a sanctions list is updated, the desk compares every earlier decision with the listed entry as it is now. Entries that changed must be looked at again; entries that were removed are offered to a person for release. Nothing is re-opened or released automatically.",
      report,
      policyVersion: policy.version,
      files: { report: "list-change-report.json" },
    }),
  );
  console.log(`${slug}: ${report.reopen.length} to re-open, ${report.release.length} to release`);
}

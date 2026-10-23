/**
 * Run the exam unattended, once or many times, and write a results file and a summary.
 *
 *   npm run bench -- --variant routed                       the full exam once
 *   npm run bench -- --variant routed --runs 3              the full exam three times
 *   npm run bench -- --variant routed --batch 20 --runs 5   five random batches of 20 alert cases
 *   npm run bench -- --variant routed,single --runs 2       several variants, one after another
 *
 * Options: --seed N (default 1; repeats the random batches exactly), --case-timeout-min M (default 180 per run),
 * --name label, --dry-run (print what would run). Each run is a separate `npm run exam` so a failure in one does not
 * stop the rest. Output: eval/results/bench-<name>-<time>.json and .md, plus the usual result file of every run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BenchRun, pickBatch, renderBenchSummary, summariseRuns } from "@sanctions-desk/agents";
import { loadExam } from "@sanctions-desk/data";
import { resolveProjectPath } from "@sanctions-desk/shared";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const variants = (flag("--variant") ?? "routed").split(",");
const runs = Number(flag("--runs") ?? 1);
const batch = flag("--batch") ? Number(flag("--batch")) : undefined;
const seed = Number(flag("--seed") ?? 1);
const timeoutMin = Number(flag("--case-timeout-min") ?? 180);
const name = (flag("--name") ?? "bench").replace(/[^A-Za-z0-9_-]/g, "");
const dry = args.includes("--dry-run");
if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error("--runs must be 1 to 50");

const alertKinds = loadExam()
  .cases.filter((c) => c.alert_id !== null)
  .map((c) => c.kind);

function runExam(
  variant: string,
  kinds: string[] | undefined,
  tag: string,
): Promise<{ file?: string; code: number | null }> {
  return new Promise((resolve) => {
    const argv = [
      "tsx",
      "tools/run-exam.ts",
      "--variant",
      variant,
      "--tag",
      tag,
      ...(kinds ? ["--kinds", kinds.join(",")] : []),
    ];
    const child = spawn("npx", argv, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      process.stdout.write(d);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMin * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file: /^saved (.+)$/m.exec(out)?.[1], code });
    });
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolveProjectPath("eval/results");
for (const variant of variants) {
  const results: BenchRun[] = [];
  const selections: string[] = [];
  for (let i = 1; i <= runs; i += 1) {
    const kinds = batch ? pickBatch(alertKinds, batch, seed + i) : undefined;
    selections.push(kinds ? kinds.join(",") : "all cases");
    console.log(
      `\n== ${variant} run ${i} of ${runs}: ${kinds ? `${kinds.length} random cases (seed ${seed + i})` : "the full exam"}`,
    );
    if (dry) continue;
    const { file, code } = await runExam(variant, kinds, `${name}-${i}`);
    if (!file) {
      results.push({ run: i, ok: false, error: `the exam run ended without a result file (exit ${code})` });
      continue;
    }
    const saved = JSON.parse(readFileSync(file, "utf8")) as { metrics: BenchRun["metrics"] };
    results.push({ run: i, ok: true, file, metrics: saved.metrics });
  }
  if (dry) continue;
  const summary = summariseRuns(results);
  const selection = batch
    ? `${runs} random batches of ${batch} alert cases (seed ${seed})`
    : `the full exam, ${runs} time${runs === 1 ? "" : "s"}`;
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `bench-${name}-${variant}-${stamp}`);
  writeFileSync(
    `${base}.json`,
    `${JSON.stringify({ variant, selection, seed, runs: results, summary, batches: selections }, null, 2)}\n`,
  );
  writeFileSync(`${base}.md`, renderBenchSummary(`Benchmark: ${variant}`, selection, summary));
  console.log(`\n${renderBenchSummary(`Benchmark: ${variant}`, selection, summary)}\nsaved ${base}.json`);
}

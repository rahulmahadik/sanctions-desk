/**
 * Save what each request in input_examples/ gives in sample mode, from a real run: the answer printed by
 * `npm run case`, the sealed decision record and the run's events. Every service address points at a closed port, so
 * nothing live is touched; the files are written once and never read back by the application.
 *
 *   npm run examples:sample            # writes output_examples/sample-mode/<alert>/
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";

const CLOSED = "http://127.0.0.1:59999";
const inputs = readdirSync(resolveProjectPath("input_examples")).filter((f) => f.endsWith(".json"));
const outRoot = resolveProjectPath("output_examples/sample-mode");

for (const file of inputs) {
  const logs = mkdtempSync(join(tmpdir(), "sample-outputs-"));
  try {
    const res = spawnSync("npx", ["tsx", "tools/run-case.ts", join("input_examples", file)], {
      cwd: resolveProjectPath("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SAMPLE_MODE: "true",
        LOG_DIR: logs,
        TRACE_STDOUT: "false",
        ZETARIS_REST_URL: `${CLOSED}/api/v1.0`,
        METERLESS_BASE_URL: `${CLOSED}/v1`,
        OLLAMA_BASE_URL: `${CLOSED}/v1`,
      },
    });
    const text = res.stdout ?? "";
    const answer = JSON.parse(text.slice(text.indexOf("{"))) as {
      run_id: string;
      status: string;
      decision?: string;
      log_file?: string;
    };
    if (answer.status !== "ok") throw new Error(`${file}: ${text.slice(0, 200)}`);
    const recordFile = readdirSync(join(logs, "records")).find((f) => f.includes(answer.run_id));
    if (!recordFile) throw new Error(`${file}: no sealed record for run ${answer.run_id}`);
    // The run wrote to a temporary folder; the saved files name it as the logs folder it stands for.
    const tidy = (s: string) => s.split(logs).join("logs");
    // The answer names the trace relative to the checkout, which here runs through the temporary folder.
    if (answer.log_file) answer.log_file = `logs/${basename(answer.log_file)}`;
    const alert = (
      JSON.parse(readFileSync(resolveProjectPath(join("input_examples", file)), "utf8")) as { alert_id: string }
    ).alert_id;
    const dir = join(outRoot, alert);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "answer.json"), `${tidy(JSON.stringify(answer, null, 2))}\n`);
    writeFileSync(join(dir, "decision-record.json"), tidy(readFileSync(join(logs, "records", recordFile), "utf8")));
    writeFileSync(
      join(dir, "run-events.jsonl"),
      tidy(readFileSync(join(logs, `trace-${answer.run_id}.jsonl`), "utf8")),
    );
    console.log(`${alert}: ${answer.decision} (${file})`);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}

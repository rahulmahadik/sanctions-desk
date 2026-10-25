/**
 * Review one alert without the interface and without starting a server:
 *
 *   npm run -s case -- input_examples/run-ALR-0004.json
 *   SAMPLE_MODE=true npm run -s case -- input_examples/run-ALR-0004.json      (saved data, no services needed)
 *   SAMPLE_MODE=true npm run -s case -- input_examples/run-ALR-0004.json | jq          (the trace lines stay on stderr)
 *
 * The file holds the body POST /run accepts ({"alert_id": "ALR-0004"} and optionally run_id, alert_type, options).
 * The review goes through the same route as POST /run, inside this process: same configuration, same data path,
 * same models, same trace file and sealed record. While it runs, one short line per trace event is printed to stderr
 * (turn that off with TRACE_STDOUT_PRETTY=false); at the end one JSON object is printed to stdout, so it can be piped. A failure is a structured error
 * and a non-zero exit code, never an invented decision.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { pino } from "pino";
import { buildApp } from "../apps/api/src/app.js";
import { createLogger } from "../apps/api/src/logger.js";
import { buildRuntime } from "../apps/api/src/runtime.js";

interface CaseError {
  type: string;
  message: string;
}

interface CaseAnswer {
  run_id?: string;
  status: "ok" | "error";
  decision?: string;
  confidence?: number;
  agents: string[];
  trace_id?: string;
  log_file?: string;
  record_hash?: string;
  execution_time_seconds: number;
  sample_mode: boolean;
  error?: CaseError;
}

const started = performance.now();
const elapsed = (): number => Math.round((performance.now() - started) / 10) / 100;

// The trace writer echoes to stdout; in this command stdout is kept for the answer alone and the echo goes to stderr.
const writeAnswer = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

function finish(answer: CaseAnswer): never {
  writeAnswer(`${JSON.stringify(answer, null, 2)}\n`);
  process.exit(answer.status === "ok" ? 0 : 1);
}

function fail(type: string, message: string, sampleMode = process.env.SAMPLE_MODE === "true"): never {
  return finish({
    status: "error",
    agents: [],
    execution_time_seconds: elapsed(),
    sample_mode: sampleMode,
    error: { type, message },
  });
}

/** The request body from the file named on the command line. */
function readRequest(): unknown {
  const file = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!file) fail("validation", "name a request file, for example: npm run case -- input_examples/run-ALR-0004.json");
  // npm runs the script from the project root; a path relative to the project root works from anywhere.
  const path = [resolve(file), resolveProjectPath(file)].find((p) => existsSync(p));
  if (!path) return fail("validation", `the request file ${file} does not exist`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return fail("validation", `the request file ${file} is not valid JSON: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const body = readRequest();

  // The same configuration as the server: the project's .env if present, then the environment.
  const envFile = resolveProjectPath(".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.env.TRACE_STDOUT_PRETTY ??= "true";

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig();
  } catch (err) {
    // Configuration problems are reported without any values.
    return fail("config_missing", err instanceof ConfigError ? err.message : (err as Error).message);
  }
  // stdout carries only the answer; the readable trace lines (when on) and the service log (warnings only) go to stderr.
  // No HTTP server is started, so the Swagger description is not built.
  const config = {
    ...loaded,
    server: { ...loaded.server, docs: false },
    logging: { ...loaded.logging, stdout: loaded.logging.pretty },
  };
  const logger = createLogger(
    { ...config, logging: { ...config.logging, stdout: true, level: "warn" } },
    pino.destination({ dest: 2, sync: true }),
  );

  // The person running this command already controls the process and its files, so the route is called without the
  // sign-in layer. Everything after sign-in is the POST /run route itself.
  const app = await buildApp({ config, logger, ...buildRuntime(config, logger), authMode: "off" });
  try {
    const res = await app.inject({ method: "POST", url: "/run", payload: body as Record<string, unknown> });
    const answer = res.json() as Partial<CaseAnswer> & { error?: CaseError & Record<string, unknown> };
    // Fields the answer does not have stay undefined and are left out of the printed JSON.
    finish({
      run_id: answer.run_id,
      status: res.statusCode === 200 && answer.status === "ok" ? "ok" : "error",
      decision: answer.decision,
      confidence: answer.confidence,
      agents: answer.agents ?? [],
      trace_id: answer.trace_id,
      log_file: answer.log_file,
      record_hash: answer.record_hash,
      execution_time_seconds: Math.round((answer.execution_time_seconds ?? elapsed()) * 1000) / 1000,
      sample_mode: config.sampleMode,
      error: answer.error && { type: answer.error.type, message: answer.error.message },
    });
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => fail("internal", err instanceof Error ? err.message : String(err)));

import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  AppError,
  type Config,
  createTraceLogger,
  makeRedactor,
  type PolicyStore,
  type RunEventBus,
  RunRequestSchema,
  RunResponseSchema,
  secretValues,
} from "@sanctions-desk/shared";
import type { FastifyPluginAsync } from "fastify";

interface RunOptions {
  config: Config;
  bus: RunEventBus;
  policies: PolicyStore;
}

/**
 * POST /run is the programmatic entry point. A valid request is traced and answered with a structured
 * `not_implemented` error while the agent pipeline is not enabled. It never returns an invented decision.
 */
export const runRoutes: FastifyPluginAsync<RunOptions> = async (app, { config, bus, policies }) => {
  const redact = makeRedactor(secretValues(config));

  app.post("/run", async (req, reply) => {
    const started = performance.now();
    const parsed = RunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation", "invalid run request", {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }

    const runId = parsed.data.run_id ?? randomUUID();
    // The run keeps the policy it starts with, even if a new version is published while it runs.
    const policy = policies.active();
    const trace = createTraceLogger({
      runId,
      dir: config.logging.dir,
      redact,
      stdout: config.logging.stdout,
      bus,
      policyVersion: policy.version,
    });
    const error = new AppError("not_implemented", "the agent pipeline is not enabled in this build", {
      recoverable: false,
    }).toJSON();

    trace.log({
      agent: "system",
      action: "run_rejected",
      status: "error",
      input_summary: `${parsed.data.alert_type}: ${parsed.data.alert_id ? `alert_id=${parsed.data.alert_id}` : "inline alert"}`,
      output_summary: error.message,
    });

    const body = RunResponseSchema.parse({
      run_id: runId,
      status: "error",
      alert_type: parsed.data.alert_type,
      policy_version: policy.version,
      what_would_change: [],
      citations: [],
      agents: [],
      trace_id: runId,
      log_file: relative(process.cwd(), trace.file),
      execution_time_seconds: (performance.now() - started) / 1000,
      error,
    });
    return reply.status(501).send(body);
  });
};

import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { type AgentDeps, runReview } from "@sanctions-desk/agents";
import {
  type AlertType,
  AppError,
  type Config,
  createTraceLogger,
  type Generator,
  makeRedactor,
  type PolicyStore,
  projectRoot,
  type RunEventBus,
  RunRequestSchema,
  RunResponseSchema,
  secretValues,
  type TraceLogger,
  toStructuredError,
} from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import type { FastifyPluginAsync } from "fastify";
import { mapError } from "../errors.js";

interface RunOptions {
  config: Config;
  bus: RunEventBus;
  policies: PolicyStore;
  generator: Generator;
  zetaris: ZetarisClient;
  /** Set when answers come from saved data and the rules-based model instead of live services. */
  sampleNotice?: string;
}

/**
 * POST /run reviews one alert. The review reads the semantic layer through Zetaris, asks the configured
 * models, has the critic verify every cited fact, applies the active policy and answers with a recommendation
 * for a person to act on. A failure is a structured error, never an invented decision.
 */
export const runRoutes: FastifyPluginAsync<RunOptions> = async (
  app,
  { config, bus, policies, generator, zetaris, sampleNotice },
) => {
  const redact = makeRedactor(secretValues(config));
  // One review per alert at a time: a second request for the same alert would only repeat the same reads.
  const running = new Set<string>();

  /** The structured answer for a run that did not produce a recommendation. */
  const errorBody = (
    trace: TraceLogger,
    run: { runId: string; alertType: AlertType; policyVersion: number; started: number },
    error: AppError,
  ) =>
    RunResponseSchema.parse({
      run_id: run.runId,
      status: "error",
      alert_type: run.alertType,
      policy_version: run.policyVersion,
      what_would_change: [],
      citations: [],
      agents: [],
      trace_id: run.runId,
      log_file: relative(projectRoot(), trace.file),
      execution_time_seconds: (performance.now() - run.started) / 1000,
      error: error.toJSON(),
    });

  app.post("/run", async (req, reply) => {
    const started = performance.now();
    const parsed = RunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation", "invalid run request", {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const request = parsed.data;
    const runId = request.run_id ?? randomUUID();
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
    const run = { runId, alertType: request.alert_type, policyVersion: policy.version, started };
    const refuse = (error: AppError, event: "run_rejected" | "run_failed") => {
      trace.log({
        agent: "system",
        action: event,
        status: "error",
        input_summary: `${request.alert_type}: ${request.alert_id ? `alert_id=${request.alert_id}` : "inline alert"}`,
        output_summary: error.message,
      });
      return reply.status(mapError(error).statusCode).send(errorBody(trace, run, error));
    };

    if (request.alert_type !== "customer" || request.alert_id === undefined) {
      return refuse(
        new AppError("not_implemented", "only customer alerts identified by alert_id can be reviewed in this build"),
        "run_rejected",
      );
    }
    const alertId = request.alert_id;
    if (running.has(alertId)) {
      return refuse(
        new AppError("validation", `alert ${alertId} is already being reviewed`, { recoverable: true }),
        "run_rejected",
      );
    }

    running.add(alertId);
    trace.log({
      agent: "system",
      action: "run_started",
      status: "ok",
      input_summary: `customer alert ${alertId}`,
      detail: { sample_mode: config.sampleMode },
    });
    try {
      const deps: AgentDeps = { config, policy, zetaris, generator, trace, now: () => new Date() };
      const result = await runReview(deps, { runId, alertId, sampleMode: config.sampleMode, sampleNotice });
      trace.log({
        agent: "system",
        action: "run_completed",
        status: "ok",
        output_summary: `${result.decision} (confidence ${result.confidence})`,
        detail: { record_hash: result.record_hash },
      });
      return reply.status(200).send({ ...result, log_file: relative(projectRoot(), trace.file) });
    } catch (err) {
      const e = toStructuredError(err);
      return refuse(
        err instanceof AppError ? err : new AppError(e.type, e.message, { recoverable: e.recoverable }),
        "run_failed",
      );
    } finally {
      running.delete(alertId);
    }
  });
};

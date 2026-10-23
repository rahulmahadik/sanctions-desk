import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  type AgentDeps,
  autonomyUsage,
  killSwitchOn,
  readAnalystMemory,
  readDecisionRecords,
  recordAutoClose,
  runReview,
  type Signer,
} from "@sanctions-desk/agents";
import {
  type AlertType,
  AppError,
  type Config,
  createTraceLogger,
  type Generator,
  makeRedactor,
  type Policy,
  type PolicyStore,
  projectRoot,
  type RunEventBus,
  RunRequestSchema,
  RunResponseSchema,
  resolveProjectPath,
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
  /** Signs the note written for an automatic close. Absent: hash-sealed. */
  signer?: Signer;
}

/**
 * POST /run reviews one alert. The review reads the semantic layer through Zetaris, asks the configured
 * models, has the critic verify every cited fact, applies the active policy and answers with a recommendation
 * for a person to act on. A failure is a structured error, never an invented decision.
 */
export const runRoutes: FastifyPluginAsync<RunOptions> = async (
  app,
  { config, bus, policies, generator, zetaris, sampleNotice, signer },
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

  /** What a review may use besides the data and the models: earlier decisions, the kill switch and today's count. */
  const agentDeps = (policy: Policy, trace: TraceLogger): AgentDeps => ({
    config,
    policy,
    zetaris,
    generator,
    trace,
    now: () => new Date(),
    analystDecisions: (customerId, entryId) => readAnalystMemory(config.logging.dir, customerId, entryId),
    killSwitch: () => killSwitchOn(config.logging.dir),
    autoClosedToday: () => autonomyUsage(config.logging.dir, new Date()).auto_closed,
  });

  /** A close the desk made on its own gets its closure note and an audit line under the policy. */
  const noteAutoClose = (runId: string, policy: Policy): void => {
    const [record] = readDecisionRecords(config.logging.dir, (x) => x.run_id === runId);
    if (!record) return;
    const stores = {
      logDir: resolveProjectPath(config.logging.dir),
      outboxDir: resolveProjectPath(config.actions.outboxDir),
      signer,
    };
    recordAutoClose(stores, policy, record, new Date());
  };

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
      pretty: config.logging.pretty,
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

    if (request.alert_id === undefined) {
      return refuse(
        new AppError("not_implemented", "only alerts identified by alert_id can be reviewed in this build"),
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
      input_summary: `${request.alert_type} alert ${alertId}`,
      detail: { sample_mode: config.sampleMode },
    });
    try {
      const result = await runReview(agentDeps(policy, trace), {
        runId,
        alertId,
        sampleMode: config.sampleMode,
        sampleNotice,
      });
      if (result.autonomy?.outcome === "auto_closed") noteAutoClose(runId, policy);
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

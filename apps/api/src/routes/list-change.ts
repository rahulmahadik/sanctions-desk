import { randomUUID } from "node:crypto";
import { type AgentDeps, replayListChange } from "@sanctions-desk/agents";
import {
  AppError,
  type Config,
  createTraceLogger,
  type Generator,
  makeRedactor,
  type PolicyStore,
  secretValues,
} from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

interface ListChangeOptions {
  config: Config;
  policies: PolicyStore;
  generator: Generator;
  zetaris: ZetarisClient;
}

const RequestSchema = z.strictObject({
  batch_size: z.number().int().min(1).max(500).optional(),
  max_batches: z.number().int().min(1).max(32).optional(),
  cursor: z.number().int().min(0).optional(),
});

/**
 * POST /list-change/replay compares every earlier decision with the listed entry as it is now. Entries that
 * changed are returned as cases to re-open; entries that were removed are returned as candidates for a person
 * to release. It changes nothing: no case is reopened or released until a person does it.
 */
export const listChangeRoutes: FastifyPluginAsync<ListChangeOptions> = async (app, deps) => {
  const redact = makeRedactor(secretValues(deps.config));

  app.post("/list-change/replay", async (req) => {
    const parsed = RequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation", "invalid replay request", {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const policy = deps.policies.active();
    const runId = `replay-${randomUUID()}`;
    const trace = createTraceLogger({
      runId,
      dir: deps.config.logging.dir,
      redact,
      stdout: deps.config.logging.stdout,
      pretty: deps.config.logging.pretty,
      policyVersion: policy.version,
    });
    const agentDeps: AgentDeps = {
      config: deps.config,
      policy,
      zetaris: deps.zetaris,
      generator: deps.generator,
      trace,
      now: () => new Date(),
    };
    const report = await replayListChange(agentDeps, {
      batchSize: parsed.data.batch_size,
      maxBatches: parsed.data.max_batches,
      cursor: parsed.data.cursor,
    });
    return { ...report, policy_version: policy.version, trace_id: runId };
  });
};

import { randomUUID } from "node:crypto";
import { type AgentDeps, screenOutbound } from "@sanctions-desk/agents";
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

interface GuardOptions {
  config: Config;
  policies: PolicyStore;
  generator: Generator;
  zetaris: ZetarisClient;
}

const OutboundRequestSchema = z.strictObject({ text: z.string().min(1).max(5000) });

/**
 * POST /guard/outbound checks a draft meant for a customer or anyone outside the bank. The desk never sends
 * anything itself; a person (or a tool they use) asks here before sending. A draft that states or hints that a
 * customer is being screened or investigated is refused.
 */
export const guardRoutes: FastifyPluginAsync<GuardOptions> = async (app, { config, policies, generator, zetaris }) => {
  const redact = makeRedactor(secretValues(config));

  app.post("/guard/outbound", async (req) => {
    const parsed = OutboundRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation", "invalid draft", {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const policy = policies.active();
    const runId = `guard-${randomUUID()}`;
    const trace = createTraceLogger({
      runId,
      dir: config.logging.dir,
      redact,
      stdout: config.logging.stdout,
      policyVersion: policy.version,
    });
    const deps: AgentDeps = { config, policy, zetaris, generator, trace, now: () => new Date() };
    const result = await screenOutbound(deps, parsed.data.text);
    return {
      allowed: !result.violation,
      category: result.category,
      reasons: result.reasons,
      policy_version: policy.version,
      trace_id: runId,
      models: result.calls,
    };
  });
};

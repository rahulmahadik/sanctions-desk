import { buildTraceContract, readDecisionRecords } from "@sanctions-desk/agents";
import { AppError, type Config, RunIdSchema } from "@sanctions-desk/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

interface TraceOptions {
  config: Config;
}

const CaseIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

/**
 * The decision trace of a recommendation: which definitions applied, what data it rested on, who could see
 * what, and what it cost. Everything comes from the sealed decision record, never from a fresh run.
 */
export const traceRoutes: FastifyPluginAsync<TraceOptions> = async (app, { config }) => {
  app.get<{ Params: { alertId: string } }>("/cases/:alertId/trace", async (req) => {
    const id = CaseIdSchema.safeParse(req.params.alertId);
    if (!id.success) throw new AppError("not_found", "no such case");
    const [latest] = readDecisionRecords(config.logging.dir, (r) => r.alert_ref === id.data);
    if (!latest) throw new AppError("not_found", `no recommendation has been recorded for ${id.data}`);
    return buildTraceContract(latest, config.costs);
  });

  app.get<{ Params: { runId: string } }>("/runs/:runId/trace", async (req) => {
    const id = RunIdSchema.safeParse(req.params.runId);
    if (!id.success) throw new AppError("not_found", "no such run");
    const [record] = readDecisionRecords(config.logging.dir, (r) => r.run_id === id.data);
    if (!record) throw new AppError("not_found", `no recommendation was recorded for run ${id.data}`);
    return buildTraceContract(record, config.costs);
  });
};

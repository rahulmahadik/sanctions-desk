import { buildTraceContract, readDecisionRecords } from "@sanctions-desk/agents";
import { AppError, type Config, type DecisionRecord, RunIdSchema } from "@sanctions-desk/shared";
import { auditToken, fetchQueryHistory, matchAudit } from "@sanctions-desk/zetaris";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

interface TraceOptions {
  config: Config;
}

const wantsAudit = (query: unknown): boolean => (query as { audit?: string }).audit === "true";

/** Match each query in the record with Zetaris's own history of statements. Sample mode has no live platform to ask. */
async function auditOf(config: Config, record: DecisionRecord) {
  const token = auditToken(config);
  if (config.sampleMode)
    return { available: false, reason: "sample mode replays saved answers; there is no live platform to ask" };
  if (!token) return { available: false, reason: "no Zetaris token is configured" };
  try {
    const history = await fetchQueryHistory(config, token);
    return matchAudit(record.queries, history);
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : "the history could not be read" };
  }
}

const CaseIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

/**
 * The decision trace of a recommendation: which definitions applied, what data it rested on, who could see
 * what, and what it cost. Everything comes from the sealed decision record, never from a fresh run.
 */
export const traceRoutes: FastifyPluginAsync<TraceOptions> = async (app, { config }) => {
  app.get<{ Params: { alertId: string }; Querystring: { audit?: string } }>("/cases/:alertId/trace", async (req) => {
    const id = CaseIdSchema.safeParse(req.params.alertId);
    if (!id.success) throw new AppError("not_found", "no such case");
    const [latest] = readDecisionRecords(config.logging.dir, (r) => r.alert_ref === id.data);
    if (!latest) throw new AppError("not_found", `no recommendation has been recorded for ${id.data}`);
    const contract = buildTraceContract(latest, config.costs);
    return wantsAudit(req.query) ? { ...contract, audit: await auditOf(config, latest) } : contract;
  });

  app.get<{ Params: { runId: string }; Querystring: { audit?: string } }>("/runs/:runId/trace", async (req) => {
    const id = RunIdSchema.safeParse(req.params.runId);
    if (!id.success) throw new AppError("not_found", "no such run");
    const [record] = readDecisionRecords(config.logging.dir, (r) => r.run_id === id.data);
    if (!record) throw new AppError("not_found", `no recommendation was recorded for run ${id.data}`);
    const contract = buildTraceContract(record, config.costs);
    return wantsAudit(req.query) ? { ...contract, audit: await auditOf(config, record) } : contract;
  });
};

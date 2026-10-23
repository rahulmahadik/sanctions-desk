import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTraceContract, readDecisionRecords } from "@sanctions-desk/agents";
import {
  AppError,
  type Config,
  type DecisionRecord,
  RunIdSchema,
  resolveProjectPath,
  verifyReceipt,
} from "@sanctions-desk/shared";
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

  /**
   * Check one signed receipt now, from the file stored beside the trace: the signature over the receipt body, whether
   * the signing key is the one pinned in the configuration, and what the receipt says about the call (the app, the
   * mode asked for and routed, and the model that served it). Nothing here asks the runtime.
   */
  app.get<{ Params: { receiptId: string } }>("/receipts/:receiptId/verify", async (req) => {
    const id = z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .safeParse(req.params.receiptId);
    if (!id.success) throw new AppError("not_found", "no such receipt");
    const file = join(resolveProjectPath(config.logging.dir), "receipts", `${id.data}.json`);
    if (!existsSync(file)) throw new AppError("not_found", `no stored receipt ${id.data}`);
    const envelope: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = verifyReceipt(envelope, config.nightshift.receiptPublicKeys);
    const body = (envelope as { body?: { receipt?: Record<string, unknown> }; pubkey_b64?: string }).body;
    const r = (body?.receipt ?? {}) as Record<string, unknown>;
    const policy = (r.app_policy ?? {}) as Record<string, unknown>;
    const route = (r.winning_route ?? {}) as Record<string, unknown>;
    return {
      receipt_id: id.data,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      body_hash: result.bodyHash ?? null,
      signer_public_key: (envelope as { pubkey_b64?: string }).pubkey_b64 ?? null,
      key_pinned: result.status === "valid_pinned",
      app: r.app ?? null,
      requested_mode: policy.requested_mode ?? null,
      routed_mode: policy.routed_mode ?? null,
      mode_coerced: policy.mode_coerced ?? null,
      served_by: route.model ?? null,
      route_kind: route.kind ?? null,
    };
  });
};

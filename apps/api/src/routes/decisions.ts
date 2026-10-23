import {
  type ActionRecord,
  attempt,
  type CaseRef,
  type DeskStores,
  humanState,
  readActions,
  readAlertQueue,
  readDecisionRecords,
  recordDecision,
  type Signer,
  secondApproval,
  verifyAction,
} from "@sanctions-desk/agents";
import {
  AppError,
  type AuthMode,
  type Config,
  can,
  DEMO_USERS,
  type DecisionRecord,
  DecisionSchema,
  type PolicyStore,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

interface DecisionOptions {
  config: Config;
  policies: PolicyStore;
  zetaris: ZetarisClient;
  signer?: Signer;
  mode: AuthMode;
}

const CaseIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const RecordHash = z.string().regex(/^[0-9a-f]{64}$/);
const DecisionBody = z.strictObject({
  action: z.enum(["approve", "override"]),
  outcome: DecisionSchema.optional(),
  reason: z.string().max(2000),
  record_hash: RecordHash,
});
const SecondBody = z.strictObject({ approve: z.boolean(), reason: z.string().max(2000), record_hash: RecordHash });

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("validation", "invalid request", {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return parsed.data;
};

/**
 * The human decision step: a person approves or overrides a recommendation with a reason, a block needs a second,
 * different approver, and the next action is prepared only afterwards. Nothing is sent or executed.
 */
export const decisionRoutes: FastifyPluginAsync<DecisionOptions> = async (
  app,
  { config, policies, zetaris, signer, mode },
) => {
  const logDir = resolveProjectPath(config.logging.dir);
  const stores: DeskStores = { logDir, outboxDir: resolveProjectPath(config.actions.outboxDir), signer };

  const latest = (alertId: string): DecisionRecord => {
    const record = readDecisionRecords(logDir, (r) => r.alert_ref === alertId)[0];
    if (!record) throw new AppError("not_found", `alert ${alertId} has no recommendation yet; run a review first`);
    return record;
  };

  const withCheck = (a: ActionRecord) => ({ ...a, check: verifyAction(a, config.actions.publicKey) });

  const view = (alertId: string, record: DecisionRecord, actions: ActionRecord[]) => {
    const state = humanState(record);
    return {
      alert_id: alertId,
      record_hash: record.record_hash,
      recommendation: { decision: record.decision, confidence: record.confidence, rationale: record.rationale },
      status: state.status,
      final: state.final ?? null,
      actions_taken: record.human,
      records_sealed_with: signer ? "ed25519" : "hash-sealed",
      next_actions: actions.map(withCheck),
    };
  };

  app.get("/me", async (req) => ({
    user: { id: req.actor.id, role: req.actor.role, demo: req.actor.demo },
    auth: mode,
    // Demo users are listed only where they work: in sample mode.
    demo_users: config.sampleMode && mode !== "on" ? DEMO_USERS.map(({ id, role }) => ({ id, role })) : [],
    permissions: {
      decide: can(req.actor, "decide"),
      approve_block: can(req.actor, "approveBlock"),
      override_towards_less_caution: can(req.actor, "overrideTowardsLessCaution"),
      propose_policy: can(req.actor, "proposePolicy"),
      publish_policy: can(req.actor, "publishPolicy"),
    },
    records_sealed_with: signer ? "ed25519" : "hash-sealed",
    ...(config.actions.publicKey ? { signing_public_key: config.actions.publicKey } : {}),
  }));

  app.get<{ Params: { alertId: string } }>("/cases/:alertId/human", async (req) => {
    const alertId = parse(CaseIdSchema, req.params.alertId);
    return view(alertId, latest(alertId), readActions(stores.outboxDir, alertId));
  });

  app.get<{ Params: { alertId: string } }>("/cases/:alertId/actions", async (req) => {
    const alertId = parse(CaseIdSchema, req.params.alertId);
    return { alert_id: alertId, actions: readActions(stores.outboxDir, alertId).map(withCheck) };
  });

  const caseRef = async (alertId: string): Promise<CaseRef> => {
    const item = (await readAlertQueue({ zetaris, config })).find((a) => a.alert_id === alertId);
    if (!item) throw new AppError("not_found", `alert ${alertId} is not in the queue`);
    return { customerId: item.customer_id, entryId: item.entry_id };
  };

  app.post<{ Params: { alertId: string } }>("/cases/:alertId/decision", async (req, reply) => {
    const alertId = parse(CaseIdSchema, req.params.alertId);
    const body = parse(DecisionBody, req.body);
    const record = latest(alertId);
    const ref = await caseRef(alertId);
    const now = new Date();
    const done = attempt(stores, policies.active(), req.actor, "decision", record, ref, now, () =>
      recordDecision(record, body, req.actor, now),
    );
    return reply.status(201).send(view(alertId, done.record, done.actions));
  });

  app.post<{ Params: { alertId: string } }>("/cases/:alertId/second-approval", async (req, reply) => {
    const alertId = parse(CaseIdSchema, req.params.alertId);
    const body = parse(SecondBody, req.body);
    const record = latest(alertId);
    const ref = await caseRef(alertId);
    const now = new Date();
    const done = attempt(stores, policies.active(), req.actor, "second_approval", record, ref, now, () =>
      secondApproval(record, body, req.actor, now),
    );
    return reply.status(201).send(view(alertId, done.record, done.actions));
  });
};

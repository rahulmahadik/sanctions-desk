import {
  type ActionRecord,
  attempt,
  audit,
  autoClosedRecords,
  autonomyUsage,
  buildTraceContract,
  type CaseRef,
  createIntentGate,
  type DeskStores,
  gatherEvidence,
  humanState,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  markdownToPdf,
  readActions,
  readAlertQueue,
  readDecisionRecords,
  readKillSwitch,
  readRunEvents,
  recordDecision,
  renderCaseFile,
  reopen,
  type Signer,
  secondApproval,
  setKillSwitch,
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
import { SafeIdSchema } from "../ids.js";
import { refuseGenerator, silentTrace } from "./desk.js";

interface DecisionOptions {
  config: Config;
  policies: PolicyStore;
  zetaris: ZetarisClient;
  signer?: Signer;
  mode: AuthMode;
}

const CaseIdSchema = SafeIdSchema;
const RecordHash = z.string().regex(/^[0-9a-f]{64}$/);
/** The reason a person gives: the human decision step's one rule, checked here at the edge and again inside it. */
export const ReasonSchema = z.string().trim().min(MIN_REASON_LENGTH).max(MAX_REASON_LENGTH);
const DecisionBody = z.strictObject({
  action: z.enum(["approve", "override"]),
  outcome: DecisionSchema.optional(),
  reason: ReasonSchema,
  record_hash: RecordHash,
});
const ReopenBody = z.strictObject({ reason: ReasonSchema, record_hash: RecordHash });
const KillBody = z.strictObject({ active: z.boolean(), reason: ReasonSchema });
const SecondBody = z.strictObject({ approve: z.boolean(), reason: ReasonSchema, record_hash: RecordHash });

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
  const stores: DeskStores = {
    logDir,
    outboxDir: resolveProjectPath(config.actions.outboxDir),
    signer,
    // Optional, off by default: Scout Intent checks each next-action record before it is sealed.
    ...(config.actions.scoutIntent ? { intentGate: createIntentGate() } : {}),
  };

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
      // A person's action re-seals the record with the action added; this names the record it was added to.
      previous_record_hash: record.previous_record_hash ?? null,
      recommendation: { decision: record.decision, confidence: record.confidence, rationale: record.rationale },
      autonomy: record.autonomy
        ? {
            outcome: record.autonomy.outcome,
            statement: record.autonomy.statement ?? null,
            level_in_force: record.autonomy.level_in_force,
          }
        : null,
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

  app.post<{ Params: { alertId: string } }>("/cases/:alertId/reopen", async (req, reply) => {
    const alertId = parse(CaseIdSchema, req.params.alertId);
    const body = parse(ReopenBody, req.body);
    const record = latest(alertId);
    const ref = await caseRef(alertId);
    const now = new Date();
    const done = attempt(stores, policies.active(), req.actor, "reopen", record, ref, now, () =>
      reopen(record, body, req.actor, now),
    );
    return reply.status(201).send(view(alertId, done.record, done.actions));
  });

  /** What the autonomy setting is doing now: the level in force, today's closes against the cap, the kill switch. */
  const autonomyView = () => {
    const policy = policies.active();
    const kill = readKillSwitch(stores.logDir);
    const usage = autonomyUsage(stores.logDir, new Date());
    return {
      policy_version: policy.version,
      policy_level: policy.autonomy.level,
      level_in_force: policy.autonomy.level === 1 && kill?.active !== true ? 1 : 0,
      kill_switch: kill ?? { active: false },
      settings: policy.autonomy,
      today: { ...usage, cap: policy.autonomy.autoClose.dailyCap },
      locked: [
        "an escalation or a request for information always goes to a person",
        "a recommended block needs two different approvers",
        "no automatic block, no message to a customer, no write to a source system",
      ],
    };
  };
  app.get("/autonomy", async () => autonomyView());

  app.post("/autonomy/kill-switch", async (req) => {
    const body = parse(KillBody, req.body);
    // Stopping autonomy is safe, so an approver may do it at once; starting it again takes a policy admin.
    if (!body.active && !can(req.actor, "restoreAutonomy"))
      throw new AppError("forbidden", "only a policy admin can switch autonomy back on");
    const state = { active: body.active, by: req.actor.id, at: new Date().toISOString(), reason: body.reason };
    setKillSwitch(stores.logDir, state);
    audit(stores.logDir, {
      user: req.actor.id,
      role: req.actor.role,
      action: "kill_switch",
      result: body.active ? "on" : "off",
      reason: body.reason,
    });
    return autonomyView();
  });

  /** Closes the desk made without waiting, newest first, for a person to review and reopen. */
  app.get("/auto-closed", async () => ({
    items: autoClosedRecords(logDir).map((r) => ({
      alert_id: r.alert_ref,
      record_hash: r.record_hash,
      decided_at: r.decided_at,
      statement: r.autonomy?.statement ?? "",
      policy_version: r.policy.version,
      confidence: r.confidence,
      rationale: r.rationale,
      status: humanState(r).status,
      reopened_by: r.human.find((h) => h.action === "reopen")?.actor ?? null,
    })),
  }));

  /**
   * The case file: one document that says what the desk recommended and why, what the case rests on, what people did,
   * what was prepared next, which model answered each step and the sealed record's hash. Markdown or PDF.
   */
  app.get<{ Params: { alertId: string }; Querystring: { format?: string } }>(
    "/cases/:alertId/file",
    async (req, reply) => {
      const alertId = parse(CaseIdSchema, req.params.alertId);
      const format = parse(z.enum(["md", "pdf"]).default("md"), req.query.format);
      const record = latest(alertId);
      const evidence = await gatherEvidence(
        {
          config,
          policy: policies.active(),
          zetaris,
          generator: refuseGenerator,
          trace: silentTrace(`file-${alertId}`),
          now: () => new Date(),
        },
        alertId,
      );
      const show = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "not on record" : v);
      const facts = [
        { label: "Customer", value: `${show(evidence.customer.full_name)} (${show(evidence.customer.customer_type)})` },
        { label: "Customer date of birth (record)", value: show(evidence.customer.date_of_birth) },
        { label: "Customer nationality", value: show(evidence.customer.nationality) },
        { label: "Customer note", value: show(evidence.customer.notes) },
        { label: "Listed party", value: `${show(evidence.entry.primary_name)} (${show(evidence.entry.list_id)})` },
        { label: "Listed dates of birth", value: evidence.dobs.map((d) => show(d.dob_value)).join("; ") || "none" },
        ...(evidence.payment
          ? [
              {
                label: "Payment counterparty",
                value: `${show(evidence.payment.counterparty_name)} (${show(evidence.payment.counterparty_country)})`,
              },
              { label: "Payment reference", value: show(evidence.payment.payment_reference) },
            ]
          : []),
        {
          label: "Identifier numbers",
          value: "masked for the evidence role; whether one matches a listed number was decided inside Zetaris",
        },
      ];
      const text = renderCaseFile({
        title: `Case file: alert ${alertId}`,
        summary: `Alert ${alertId} (${record.alert_type}), reviewed under policy version ${record.policy.version}. Synthetic customer data; the listed party is a public sanctions-list entry.`,
        record,
        events: readRunEvents(logDir, record),
        contract: buildTraceContract(record, config.costs),
        files: {
          record: `GET /cases/${alertId}/record`,
          trace: `GET /cases/${alertId}/trace`,
          events: `GET /runs/${record.run_id}/events`,
        },
        actions: readActions(stores.outboxDir, alertId).map(withCheck),
        facts,
      });
      reply.header("content-disposition", `attachment; filename="case-file-${alertId}.${format}"`);
      return format === "pdf"
        ? reply.type("application/pdf").send(markdownToPdf(text, `record ${record.record_hash.slice(0, 16)}`))
        : reply.type("text/markdown; charset=utf-8").send(text);
    },
  );
};

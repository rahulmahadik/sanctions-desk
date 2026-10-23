import { readFileSync } from "node:fs";
import { replayWhatIf, type WhatIfCase } from "@sanctions-desk/agents";
import { loadExam } from "@sanctions-desk/data";
import {
  ANONYMOUS,
  AppError,
  type Config,
  type Generator,
  type PolicyStore,
  policyRef,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

interface PolicyOptions {
  policies: PolicyStore;
  config: Config;
  generator: Generator;
  zetaris: ZetarisClient;
}

const Person = z.string().trim().min(1).max(100);
const DraftBody = z.strictObject({ policy: z.unknown(), proposed_by: Person, reason: z.string().max(500).optional() });
const PublishBody = z.strictObject({ approved_by: Person });
const DiscardBody = z.strictObject({ actor: Person });
const RollbackBody = z.strictObject({ to_version: z.number().int().positive(), proposed_by: Person });
const ReloadBody = z.strictObject({ proposed_by: Person, reason: z.string().max(500).optional() });
const WhatIfBody = z.strictObject({
  version: z.number().int().positive(),
  /** Exam case ids (EX-001) or kinds. Omitted: the first `limit` cases that have an alert. */
  cases: z.array(z.string().max(100)).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

/**
 * Who is acting. A signed-in user is the author or approver; a body that names someone else is refused, so the
 * four-eyes rule rests on identities the caller cannot choose. With auth off (tests) the body names the person.
 */
function actingAs(req: FastifyRequest, body: unknown, fields: readonly string[]): Record<string, unknown> {
  const given = (body ?? {}) as Record<string, unknown>;
  if (req.actor.id === ANONYMOUS.id) return given;
  const out = { ...given };
  for (const f of fields) {
    if (out[f] !== undefined && out[f] !== req.actor.id)
      throw new AppError("forbidden", `${f} must be you (${req.actor.id}) or left out`);
    out[f] = req.actor.id;
  }
  return out;
}

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("validation", "invalid request", {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return parsed.data;
};

const summary = (r: ReturnType<PolicyStore["list"]>[number]) => ({
  version: r.policy.version,
  name: r.policy.name,
  status: r.status,
  proposed_by: r.proposedBy,
  approved_by: r.approvedBy ?? null,
  created_at: r.createdAt,
  published_at: r.publishedAt ?? null,
  reason: r.reason ?? null,
  rollback_of: r.rollbackOf ?? null,
});

/**
 * The versioned policy. A change is a draft, then a publish by a second person; a published version applies
 * to the next run without a restart, and a run keeps the version it started with. The policy schema fixes
 * the hard limits (no automatic block, no customer messages, read-only data), so no draft can lift them.
 */
export const policyRoutes: FastifyPluginAsync<PolicyOptions> = async (
  app,
  { policies, config, generator, zetaris },
) => {
  app.get("/policy", async () => {
    const policy = policies.active();
    return { ...policyRef(policy), policy };
  });

  app.get("/policy/versions", async () => ({
    active_version: policies.activeVersion(),
    versions: policies.list().map(summary),
  }));

  app.get<{ Params: { version: string } }>("/policy/versions/:version", async (req) => {
    const version = Number(req.params.version);
    const record = Number.isInteger(version) ? policies.get(version) : undefined;
    if (!record) throw new AppError("not_found", `policy version ${req.params.version} does not exist`);
    return { ...policyRef(record.policy), status: record.status, policy: record.policy };
  });

  app.get("/policy/audit", async () => ({ entries: policies.audit() }));

  app.post("/policy/drafts", async (req, reply) => {
    const body = parse(DraftBody, actingAs(req, req.body, ["proposed_by"]));
    const record = policies.createDraft(body.policy, body.proposed_by, body.reason);
    return reply.status(201).send(summary(record));
  });

  /** Read the policy file again and propose it as a draft, so an edit on disk goes through the same review. */
  app.post("/policy/reload", async (req, reply) => {
    const body = parse(ReloadBody, actingAs(req, req.body ?? {}, ["proposed_by"]));
    let candidate: unknown;
    try {
      candidate = JSON.parse(readFileSync(resolveProjectPath(config.policy.file), "utf8"));
    } catch (err) {
      throw new AppError("validation", `the policy file cannot be read: ${(err as Error).message.slice(0, 120)}`);
    }
    const record = policies.createDraft(candidate, body.proposed_by, body.reason ?? "reloaded from the policy file");
    return reply.status(201).send(summary(record));
  });

  app.post<{ Params: { version: string } }>("/policy/drafts/:version/publish", async (req) => {
    const body = parse(PublishBody, actingAs(req, req.body, ["approved_by"]));
    const change = policies.publish(Number(req.params.version), body.approved_by);
    return { published: change.version, replaces: change.previousVersion, at: change.at, ref: change.ref };
  });

  app.post<{ Params: { version: string } }>("/policy/drafts/:version/discard", async (req) => {
    const body = parse(DiscardBody, actingAs(req, req.body, ["actor"]));
    policies.discardDraft(Number(req.params.version), body.actor);
    return { discarded: Number(req.params.version) };
  });

  app.post("/policy/rollback", async (req, reply) => {
    const body = parse(RollbackBody, actingAs(req, req.body, ["proposed_by"]));
    return reply.status(201).send(summary(policies.rollback(body.to_version, body.proposed_by)));
  });

  /**
   * Review exam cases under the active policy and under a draft and show what would change. Nothing is saved
   * and no policy changes. In live mode every case takes two model-backed reviews, so keep the set small.
   */
  app.post("/policy/whatif", async (req) => {
    const body = parse(WhatIfBody, req.body);
    const proposed = policies.get(body.version);
    if (!proposed) throw new AppError("not_found", `policy version ${body.version} does not exist`);
    const exam = loadExam();
    const wanted = body.cases ? new Set(body.cases) : undefined;
    const cases: WhatIfCase[] = exam.cases
      .filter((c) => c.alert_id !== null && (!wanted || wanted.has(c.case_id) || wanted.has(c.kind)))
      .slice(0, wanted ? 100 : body.limit)
      .map((c) => ({
        case_id: c.case_id,
        kind: c.kind,
        group: c.group,
        alert_id: c.alert_id as string,
        expected: c.expected,
        must_not: c.must_not,
      }));
    return replayWhatIf(
      { config, zetaris, generator, now: () => new Date() },
      { cases, current: policies.active(), proposed: proposed.policy },
    );
  });
};

import { AppError, type PolicyStore, policyRef } from "@sanctions-desk/shared";
import type { FastifyPluginAsync } from "fastify";

interface PolicyOptions {
  policies: PolicyStore;
}

/** Read-only view of the versioned policy. Changes go through draft and four-eyes publish. */
export const policyRoutes: FastifyPluginAsync<PolicyOptions> = async (app, { policies }) => {
  app.get("/policy", async () => {
    const policy = policies.active();
    return { ...policyRef(policy), policy };
  });

  app.get("/policy/versions", async () => ({
    active_version: policies.activeVersion(),
    versions: policies.list().map((r) => ({
      version: r.policy.version,
      name: r.policy.name,
      status: r.status,
      proposed_by: r.proposedBy,
      approved_by: r.approvedBy ?? null,
      created_at: r.createdAt,
      published_at: r.publishedAt ?? null,
      reason: r.reason ?? null,
      rollback_of: r.rollbackOf ?? null,
    })),
  }));

  app.get<{ Params: { version: string } }>("/policy/versions/:version", async (req) => {
    const version = Number(req.params.version);
    const record = Number.isInteger(version) ? policies.get(version) : undefined;
    if (!record) throw new AppError("not_found", `policy version ${req.params.version} does not exist`);
    return { ...policyRef(record.policy), status: record.status, policy: record.policy };
  });

  app.get("/policy/audit", async () => ({ entries: policies.audit() }));
};

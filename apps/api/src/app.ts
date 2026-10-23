import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import type { Config, Generator, PolicyStore, RunEventBus } from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import fastify from "fastify";
import type { Logger } from "pino";
import { mapError } from "./errors.js";
import { createDependencyProber, type DependencyProber } from "./probes.js";
import { allowedOrigin, deskRoutes } from "./routes/desk.js";
import { governanceRoutes } from "./routes/governance.js";
import { guardRoutes } from "./routes/guard.js";
import { healthRoutes } from "./routes/health.js";
import { listChangeRoutes } from "./routes/list-change.js";
import { policyRoutes } from "./routes/policy.js";
import { runRoutes } from "./routes/run.js";
import { runEventRoutes } from "./routes/run-events.js";
import { traceRoutes } from "./routes/trace.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** The injected model seam. Agents receive this; no route calls a provider directly. */
  generator: Generator;
  /** The only way data is read. Live, or a replay of saved answers in sample mode. */
  zetaris: ZetarisClient;
  /** Shown on every answer when the review ran on saved data and the rules-based model. */
  sampleNotice?: string;
  /** Every run event is published here; live views and replays read from it. */
  bus: RunEventBus;
  /** The versioned policy. Each run reads the active version once and keeps it. */
  policies: PolicyStore;
  /** Replaceable in tests. Defaults to probing the configured runtimes. */
  prober?: DependencyProber;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Accept a caller-supplied request id only if it is safe to put in logs and headers. */
function requestIdFrom(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export async function buildApp(deps: AppDeps) {
  const { config, logger } = deps;

  const app = fastify({
    loggerInstance: logger,
    bodyLimit: config.server.bodyLimitBytes,
    requestIdHeader: false,
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
    trustProxy: false,
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    const origin = allowedOrigin(config, req.headers.origin);
    if (origin !== undefined) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
  });

  // Browser preflight for the review desk interface (only the configured origins get the headers above).
  app.options("/*", async (req, reply) => {
    const origin = allowedOrigin(config, req.headers.origin);
    if (origin === undefined) return reply.status(204).send();
    return reply
      .status(204)
      .header("access-control-allow-methods", "GET, POST, OPTIONS")
      .header("access-control-allow-headers", "content-type, x-request-id")
      .header("access-control-max-age", "600")
      .send();
  });

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, error } = mapError(err);
    if (statusCode >= 500) req.log.error({ err }, "request failed");
    else req.log.warn({ type: error.type, message: error.message }, "request rejected");
    return reply.status(statusCode).send({ status: "error", request_id: req.id, error });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      status: "error",
      request_id: req.id,
      error: {
        type: "validation",
        message: `route ${req.method} ${req.url.split("?")[0] ?? ""} not found`,
        recoverable: false,
      },
    }),
  );

  const prober = deps.prober ?? createDependencyProber(config);
  await app.register(healthRoutes, { config, prober });
  await app.register(runRoutes, {
    config,
    bus: deps.bus,
    policies: deps.policies,
    generator: deps.generator,
    zetaris: deps.zetaris,
    sampleNotice: deps.sampleNotice,
  });
  await app.register(governanceRoutes, { config, policies: deps.policies });
  await app.register(runEventRoutes, { bus: deps.bus });
  await app.register(deskRoutes, { config, bus: deps.bus, policies: deps.policies, zetaris: deps.zetaris });
  await app.register(traceRoutes, { config });
  await app.register(listChangeRoutes, {
    config,
    policies: deps.policies,
    generator: deps.generator,
    zetaris: deps.zetaris,
  });
  await app.register(guardRoutes, {
    config,
    policies: deps.policies,
    generator: deps.generator,
    zetaris: deps.zetaris,
  });
  await app.register(policyRoutes, {
    policies: deps.policies,
    config,
    generator: deps.generator,
    zetaris: deps.zetaris,
  });

  return app;
}

/** The configured server type (its logger is pino, so it is not the default FastifyInstance). */
export type App = Awaited<ReturnType<typeof buildApp>>;

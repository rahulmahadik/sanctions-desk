import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import type { Config, Generator } from "@sanctions-desk/shared";
import fastify from "fastify";
import type { Logger } from "pino";
import { mapError } from "./errors.js";
import { createDependencyProber, type DependencyProber } from "./probes.js";
import { healthRoutes } from "./routes/health.js";
import { runRoutes } from "./routes/run.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** The injected model seam. Agents receive this; no route calls a provider directly. */
  generator: Generator;
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
  await app.register(runRoutes, { config });

  return app;
}

/** The configured server type (its logger is pino, so it is not the default FastifyInstance). */
export type App = Awaited<ReturnType<typeof buildApp>>;

import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Signer } from "@sanctions-desk/agents";
import {
  type Actor,
  ANONYMOUS,
  AppError,
  type Authenticator,
  type AuthMode,
  type Config,
  can,
  createAuthenticator,
  type Generator,
  type Permission,
  type PolicyStore,
  type RunEventBus,
  resolveAuthMode,
  type UsersFile,
} from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import fastify from "fastify";
import type { Logger } from "pino";
import { mapError } from "./errors.js";
import { buildOpenApi } from "./openapi.js";
import { createDependencyProber, type DependencyProber } from "./probes.js";
import { decisionRoutes } from "./routes/decisions.js";
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
  /** The people allowed in, from the users file. Absent in sample mode, where only the demo users exist. */
  users?: UsersFile;
  /** Overrides the configured auth mode. Only tests set it; the server reads it from the configuration. */
  authMode?: AuthMode;
  /** Signs the records written after an approval. Absent: they are hash-sealed. */
  signer?: Signer;
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

/** What a route needs. Reading needs only a signed-in user; these are the exceptions. */
export function permissionFor(method: string, path: string): Permission | undefined {
  if (method === "GET") return undefined;
  if (path === "/run" || path === "/list-change/replay" || path === "/guard/outbound" || path === "/policy/whatif")
    return "run";
  if (/^\/cases\/[^/]+\/(decision|second-approval)$/.test(path)) return "decide";
  if (/^\/policy\/drafts\/\d+\/publish$/.test(path)) return "publishPolicy";
  if (path.startsWith("/policy/")) return "proposePolicy";
  return undefined;
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

  // Every route that gets registered, so a test can check that the OpenAPI description covers all of them.
  const routeTable: string[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method !== "HEAD" && method !== "OPTIONS") routeTable.push(`${method} ${route.url}`);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    const origin = allowedOrigin(config, req.headers.origin);
    if (origin !== undefined) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
  });

  const mode = deps.authMode ?? resolveAuthMode(config.server.auth, config.sampleMode);
  if (mode === "on" && !deps.users) throw new Error("auth is on but no users file is configured (DESK_USERS_FILE)");
  const authenticator: Authenticator = createAuthenticator({ mode, sampleMode: config.sampleMode, users: deps.users });
  app.decorateRequest("actor");

  // Who is calling. Every route except /health needs a signed-in user once auth is on; the token is never logged.
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? "";
    req.actor = ANONYMOUS;
    if (req.method === "OPTIONS" || path === "/health" || mode === "off") return;
    const actor = authenticator.actorFor(req.headers);
    if (!actor) throw new AppError("unauthorized", "a valid token is required");
    req.actor = actor;
    const need = permissionFor(req.method, path);
    // In sample mode anyone may read and run a review; recording a decision or changing policy needs a demo user.
    const open = mode === "demo" && need === "run";
    if (need !== undefined && !open && !can(actor, need)) {
      throw new AppError(
        "forbidden",
        mode === "demo" && actor.id === ANONYMOUS.id
          ? "choose a demo user (the X-Demo-User header) to do this"
          : `${actor.role} may not do this`,
      );
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    req.log.info(
      {
        user: req.actor.id,
        role: req.actor.role,
        method: req.method,
        route: req.routeOptions.url,
        status: reply.statusCode,
      },
      "api call",
    );
  });

  // Browser preflight for the review desk interface (only the configured origins get the headers above).
  app.options("/*", async (req, reply) => {
    const origin = allowedOrigin(config, req.headers.origin);
    if (origin === undefined) return reply.status(204).send();
    return reply
      .status(204)
      .header("access-control-allow-methods", "GET, POST, OPTIONS")
      .header("access-control-allow-headers", "content-type, authorization, x-request-id, x-demo-user")
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
  await app.register(decisionRoutes, {
    config,
    policies: deps.policies,
    zetaris: deps.zetaris,
    signer: deps.signer,
    mode,
  });
  await app.register(policyRoutes, {
    policies: deps.policies,
    config,
    generator: deps.generator,
    zetaris: deps.zetaris,
  });

  if (config.server.docs) {
    await app.register(swagger, { mode: "static", specification: { document: buildOpenApi("0.1.0") as never } });
    await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: false } });
  }

  return Object.assign(app, { routeTable });
}

/** The configured server type (its logger is pino, so it is not the default FastifyInstance). */
export type App = Awaited<ReturnType<typeof buildApp>>;

import type { Config } from "@sanctions-desk/shared";
import type { FastifyPluginAsync } from "fastify";
import pkg from "../../package.json" with { type: "json" };
import type { DependencyProber } from "../probes.js";

interface HealthOptions {
  config: Config;
  prober: DependencyProber;
}

const startedAt = Date.now();

export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, { config, prober }) => {
  /** Liveness: the process is up. Never touches other services, so it is always fast. */
  app.get("/health", async () => ({
    status: "ok",
    service: pkg.name,
    version: pkg.version,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    sample_mode: config.sampleMode,
  }));

  /**
   * Readiness: can we reach what we depend on? 200 when at least one model provider answers
   * (the generator falls back between them), 503 when none does.
   */
  app.get("/health/dependencies", async (_req, reply) => {
    const dependencies = await prober();
    const providersUp = [dependencies.nightshift, dependencies.ollama].filter((p) => p.state === "ok").length;
    const status = providersUp === 0 ? "unavailable" : dependencies.nightshift.state === "ok" ? "ok" : "degraded";
    return reply.status(status === "unavailable" ? 503 : 200).send({ status, dependencies });
  });
};

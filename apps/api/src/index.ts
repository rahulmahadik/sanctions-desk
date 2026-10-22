import { existsSync } from "node:fs";
import {
  buildGenerator,
  ConfigError,
  describeConfig,
  loadConfig,
  loadPolicyFile,
  PolicyStore,
  RunEventBus,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { buildApp } from "./app.js";
import { createLogger } from "./logger.js";

const ENV_FILE = ".env";

async function main(): Promise<void> {
  // Local development convenience: load the project's .env if present, wherever the process was started
  // (npm runs workspace scripts from their own folder). Containers pass real environment variables.
  const envFile = resolveProjectPath(ENV_FILE);
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadConfig();
  const logger = createLogger(config);
  const generator = buildGenerator(config, {
    onFallback: (from, error) =>
      logger.warn({ provider: from, error_type: error.type }, "model provider failed, falling back"),
    onAttempt: (a) => {
      const fields = {
        provider: a.provider,
        requested_model: a.requestedModel,
        routed_model: a.routedModel,
        served_mode: a.servedMode,
        status: a.status,
        outcome: a.outcome,
        error_type: a.errorType,
        latency_ms: a.latencyMs,
      };
      if (a.outcome === "ok" && a.servedMode !== undefined && a.servedMode !== a.requestedModel) {
        logger.warn(fields, "model call served a different mode than requested");
      } else if (a.outcome === "ok") {
        logger.info(fields, "model call");
      } else {
        logger.warn(fields, "model call failed");
      }
    },
  });
  const bus = new RunEventBus({
    replayLimit: config.events.replayLimit,
    maxRuns: config.events.maxRuns,
    onListenerError: (err) => logger.warn({ err }, "run event subscriber failed"),
  });
  const policies = new PolicyStore(loadPolicyFile(config.policy.file), {
    onListenerError: (err) => logger.warn({ err }, "policy change subscriber failed"),
  });

  const app = await buildApp({ config, logger, generator, bus, policies });
  logger.info(
    { config: describeConfig(config), policy_version: policies.activeVersion() },
    "starting sanctions-desk api",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const forced = setTimeout(() => {
      logger.error("graceful shutdown timed out, exiting");
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    forced.unref();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));

  await app.listen({ host: config.server.host, port: config.server.port });
}

main().catch((err: unknown) => {
  // Configuration problems are reported without any values; everything else with its message only.
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});

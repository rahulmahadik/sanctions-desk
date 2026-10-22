import { existsSync } from "node:fs";
import { buildGenerator, ConfigError, describeConfig, loadConfig } from "@sanctions-desk/shared";
import { buildApp } from "./app.js";
import { createLogger } from "./logger.js";

const ENV_FILE = ".env";

async function main(): Promise<void> {
  // Local development convenience: load .env if present. Containers pass real environment variables.
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  const config = loadConfig();
  const logger = createLogger(config);
  const generator = buildGenerator(config, {
    onFallback: (from, error) =>
      logger.warn({ provider: from, error_type: error.type }, "model provider failed, falling back"),
  });

  const app = await buildApp({ config, logger, generator });
  logger.info({ config: describeConfig(config) }, "starting sanctions-desk api");

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

import { existsSync } from "node:fs";
import { ConfigError, describeConfig, loadConfig, resolveProjectPath } from "@sanctions-desk/shared";
import { checkRoleAccess, describeAccessFailure } from "@sanctions-desk/zetaris";
import { buildApp } from "./app.js";
import { createLogger } from "./logger.js";
import { buildRuntime } from "./runtime.js";

const ENV_FILE = ".env";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

async function main(): Promise<void> {
  // Local development convenience: load the project's .env if present, wherever the process was started
  // (npm runs workspace scripts from their own folder). Containers pass real environment variables.
  const envFile = resolveProjectPath(ENV_FILE);
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadConfig();
  const logger = createLogger(config);
  // A live run reads the model with each agent's own token. After a rebuild their access is gone, so say so now,
  // with the steps that fix it, rather than failing in the middle of a review.
  if (!config.sampleMode && config.zetaris.requireRoleAccess && !config.zetaris.fallbackOnDenied) {
    const access = await checkRoleAccess(config);
    if (access.some((r) => r.state === "refused")) {
      logger.error(describeAccessFailure(access));
      process.exit(1);
    }
    if (access.some((r) => r.state === "no_token")) {
      logger.warn("some identities have no token and read with the admin key; run `npm run zetaris:agents -- --apply`");
    }
    logger.info({ roles: access.map((r) => `${r.role}:${r.state}`) }, "role access to the semantic layer verified");
  }
  // Plain HTTP beyond this machine would send bearer tokens in the clear.
  if (!config.server.tls && !LOOPBACK.has(config.server.host))
    logger.warn(
      { host: config.server.host },
      "serving plain HTTP on an address other than 127.0.0.1: set DESK_TLS_CERT_FILE and DESK_TLS_KEY_FILE, or put a TLS-terminating proxy in front (docs/API.md)",
    );
  const runtime = buildRuntime(config, logger);
  const app = await buildApp({ config, logger, ...runtime });
  logger.info(
    { config: describeConfig(config), policy_version: runtime.policies.activeVersion() },
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

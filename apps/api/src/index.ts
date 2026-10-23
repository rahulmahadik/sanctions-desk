import { existsSync } from "node:fs";
import { loadSigner, sampleRules } from "@sanctions-desk/agents";
import {
  buildGenerator,
  ConfigError,
  createFallbackRulesGenerator,
  describeConfig,
  loadConfig,
  loadPolicyFile,
  loadUsersFile,
  PolicyStore,
  RunEventBus,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import {
  checkRoleAccess,
  createZetarisClient,
  describeAccessFailure,
  loadQueryCache,
  replayFetch,
} from "@sanctions-desk/zetaris";
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
  const generator = config.sampleMode
    ? createFallbackRulesGenerator(sampleRules)
    : buildGenerator(config, {
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
  const bus = new RunEventBus({
    replayLimit: config.events.replayLimit,
    maxRuns: config.events.maxRuns,
    onListenerError: (err) => logger.warn({ err }, "run event subscriber failed"),
  });
  const policies = new PolicyStore(loadPolicyFile(config.policy.file), {
    onListenerError: (err) => logger.warn({ err }, "policy change subscriber failed"),
  });

  // The only data path. In sample mode the same client replays saved answers, so no Zetaris is needed.
  const zetaris = config.sampleMode
    ? createZetarisClient({
        config,
        offline: true,
        fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
      })
    : createZetarisClient({
        config,
        onQuery: (q) =>
          logger.info(
            {
              query_id: q.query_id,
              role: q.role,
              token_source: q.token_source,
              status: q.status,
              rows: q.row_count,
              latency_ms: q.latency_ms,
            },
            "zetaris query",
          ),
      });
  const sampleNotice = config.sampleMode
    ? "Sample mode: Zetaris answers are replayed from saved real queries and the model is a labelled rules-based fallback."
    : undefined;

  // The people allowed in (tokens are stored as hashes, in a file outside the repository) and the key that signs
  // the records written after an approval. Without a key those records are hash-sealed, and say so.
  const users = config.server.usersFile ? loadUsersFile(config.server.usersFile) : undefined;
  const signer = loadSigner(config.actions.signingKeyFile);
  const app = await buildApp({ config, logger, generator, zetaris, sampleNotice, bus, policies, users, signer });
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

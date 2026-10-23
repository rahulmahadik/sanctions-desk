import { loadSigner } from "@sanctions-desk/agents";
import {
  buildGenerator,
  type Config,
  type Generator,
  loadPolicyFile,
  loadUsersFile,
  PolicyStore,
  RunEventBus,
} from "@sanctions-desk/shared";
import { createZetarisClient, type ZetarisClient } from "@sanctions-desk/zetaris";
import type { Logger } from "pino";
import type { AppDeps } from "./app.js";
import { SAMPLE_NOTICE, sampleGenerator, sampleZetaris } from "./sample.js";

/**
 * Everything a review needs besides the HTTP layer: the model seam, the data path, the policy store, the event bus
 * and the signer. The server and `npm run case` build it the same way, so both run the same review.
 */
export function buildRuntime(config: Config, logger: Logger): Omit<AppDeps, "config" | "logger"> {
  const generator: Generator = config.sampleMode
    ? sampleGenerator()
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
  const bus = new RunEventBus({
    replayLimit: config.events.replayLimit,
    maxRuns: config.events.maxRuns,
    onListenerError: (err) => logger.warn({ err }, "run event subscriber failed"),
  });
  const policies = new PolicyStore(loadPolicyFile(config.policy.file), {
    onListenerError: (err) => logger.warn({ err }, "policy change subscriber failed"),
  });

  // The only data path. In sample mode the same client replays saved answers, so no Zetaris is needed.
  const zetaris: ZetarisClient = config.sampleMode
    ? sampleZetaris(config)
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
  const sampleNotice = config.sampleMode ? SAMPLE_NOTICE : undefined;

  // The people allowed in (tokens are stored as hashes, in a file outside the repository) and the key that signs
  // the records written after an approval. Without a key those records are hash-sealed, and say so.
  const users = config.server.usersFile ? loadUsersFile(config.server.usersFile) : undefined;
  const signer = loadSigner(config.actions.signingKeyFile);
  return { generator, zetaris, sampleNotice, bus, policies, users, signer };
}

import { sampleRules } from "@sanctions-desk/agents";
import { type Config, createFallbackRulesGenerator, type Generator, resolveProjectPath } from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch, type ZetarisClient } from "@sanctions-desk/zetaris";

/** Shown on every answer when the review ran on saved data and the rules-based model. */
export const SAMPLE_NOTICE =
  "Sample mode: Zetaris answers are replayed from saved real queries and the model is a labelled rules-based fallback.";

/** The labelled rules-based stand-in for the language model. */
export const sampleGenerator = (): Generator => createFallbackRulesGenerator(sampleRules);

/** The only data path, replaying saved answers from real Zetaris queries; it never opens a connection. */
export const sampleZetaris = (config: Config): ZetarisClient =>
  createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });

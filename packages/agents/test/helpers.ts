import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  createFallbackRulesGenerator,
  createTraceLogger,
  type GenerateRequest,
  type Generator,
  loadConfig,
  loadPolicyFile,
  type Policy,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch, type ZetarisClient } from "@sanctions-desk/zetaris";
import { type AgentDeps, sampleRules } from "../src/index.js";

export function sampleDeps(over: { generator?: Generator; policy?: Policy } = {}): AgentDeps & { logDir: string } {
  const config: Config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const logDir = mkdtempSync(join(tmpdir(), "agents-test-"));
  const zetaris: ZetarisClient = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return {
    config: { ...config, logging: { ...config.logging, dir: logDir, stdout: false } },
    policy: over.policy ?? loadPolicyFile("config/policy.default.json"),
    zetaris,
    generator: over.generator ?? createFallbackRulesGenerator(sampleRules),
    trace: createTraceLogger({ runId: "agents-test", dir: logDir, stdout: false }),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
    logDir,
  };
}

/** A generator that answers from a script, one answer per call, and remembers what it was asked. */
export function scriptedGenerator(answers: Array<string | Error>): {
  generator: Generator;
  requests: GenerateRequest[];
} {
  const requests: GenerateRequest[] = [];
  let i = 0;
  const generator: Generator = async (req) => {
    requests.push(req);
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return {
      text: next as string,
      provider: "fallback-rules",
      requestedModel: "test-model",
      routedModel: "test-model",
      routeKind: "local",
      latencyMs: 1,
      modeMismatch: false,
    };
  };
  return { generator, requests };
}

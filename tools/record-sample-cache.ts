/**
 * Record the sample cache: review every sample alert against the live Zetaris with the rules-based model,
 * and save each real answer. Sample mode later replays these answers with the same client and SQL guard.
 *
 *   npm run sample:record
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, sampleRules } from "@sanctions-desk/agents";
import {
  createFallbackRulesGenerator,
  createTraceLogger,
  loadConfig,
  loadPolicyFile,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient, emptyCache, recordingFetch, saveQueryCache } from "@sanctions-desk/zetaris";

const envFile = resolveProjectPath(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const policy = loadPolicyFile(config.policy.file);
const alerts = JSON.parse(readFileSync(resolveProjectPath("data/sample/bank/alert.json"), "utf8")) as Array<{
  alert_id: string;
}>;
const cache = emptyCache();
const zetaris = createZetarisClient({
  config,
  fetchImpl: recordingFetch((url, init) => fetch(url, init), cache),
});
const logDir = mkdtempSync(join(tmpdir(), "sample-record-"));
const generator = createFallbackRulesGenerator(sampleRules);

for (const { alert_id: alertId } of alerts) {
  const runId = `record-${alertId}`;
  const trace = createTraceLogger({ runId, dir: logDir, stdout: false, policyVersion: policy.version });
  const result = await runReview(
    {
      config: { ...config, logging: { ...config.logging, dir: logDir } },
      policy,
      zetaris,
      generator,
      trace,
      now: () => new Date(),
    },
    { runId, alertId, sampleMode: true },
  );
  console.log(`${alertId} ${result.decision} (${Object.keys(cache.entries).length} saved answers)`);
}
saveQueryCache(resolveProjectPath(config.sampleCache), cache);
console.log(`saved ${Object.keys(cache.entries).length} answers to ${config.sampleCache}`);

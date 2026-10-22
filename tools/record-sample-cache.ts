/**
 * Record the sample cache: review every sample alert against the live Zetaris with the rules-based model,
 * and save each real answer. Sample mode later replays these answers with the same client and SQL guard.
 *
 *   npm run sample:record
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayListChange, runReview, sampleRules } from "@sanctions-desk/agents";
import { loadExam } from "@sanctions-desk/data";
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
const alerts = loadExam().cases.flatMap((c) => (c.alert_id ? [{ alert_id: c.alert_id }] : []));
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
  try {
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
  } catch (err) {
    // Alerts the review does not handle yet are left out of the cache; they cannot run in sample mode either.
    console.log(`${alertId} skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
// The list-change replay reads the same data layer; its answers are saved too, so it runs in sample mode.
try {
  const trace = createTraceLogger({
    runId: "record-replay",
    dir: logDir,
    stdout: false,
    policyVersion: policy.version,
  });
  const report = await replayListChange(
    {
      config: { ...config, logging: { ...config.logging, dir: logDir } },
      policy,
      zetaris,
      generator,
      trace,
      now: () => new Date(),
    },
    {},
  );
  console.log(
    `replay: ${report.reopen.length} to re-open, ${report.release.length} to release; ${report.impact.summary}`,
  );
} catch (err) {
  console.log(`replay skipped: ${err instanceof Error ? err.message : String(err)}`);
}
saveQueryCache(resolveProjectPath(config.sampleCache), cache);
console.log(`saved ${Object.keys(cache.entries).length} answers to ${config.sampleCache}`);

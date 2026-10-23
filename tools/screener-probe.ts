/**
 * A small, labelled check outside the exam: send the screener's real system prompt and answer schema to the local
 * model with made-up text (not from any exam set), with and without schema-constrained output, and say what came back.
 *
 *   npx tsx tools/screener-probe.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { askJson, SCREENER_JSON_SCHEMA, SCREENER_SYSTEM, ScreenerAnswerSchema } from "@sanctions-desk/agents";
import {
  buildGenerator,
  createTraceLogger,
  forEvaluation,
  loadConfig,
  loadPolicyFile,
  projectRoot,
} from "@sanctions-desk/shared";
import { createZetarisClient } from "@sanctions-desk/zetaris";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}
const config = forEvaluation(loadConfig());
const policy = loadPolicyFile(config.policy.file);
const deps = {
  config,
  policy,
  zetaris: createZetarisClient({ config }),
  generator: buildGenerator(config),
  trace: createTraceLogger({
    runId: `screener-probe-${Date.now()}`,
    dir: config.logging.dir,
    stdout: false,
    policyVersion: policy.version,
  }),
  now: () => new Date(),
};
const text =
  "Customer met at branch. Passport ZX1234567 checked on 2024-05-02, ref KYC-555101, date of birth 1981-02-17. Works for his cousin's shipping firm.";
const prompt = [
  "TASK: screener",
  `<policy>${JSON.stringify({ signal_types: policy.screener.signalTypes })}</policy>`,
  `<context>${JSON.stringify({ customer_name: "Example Person", listed_name: "Other Example" })}</context>`,
  `<fields>${JSON.stringify([{ field: "customer.notes", text }])}</fields>`,
  "Give the structured facts as the JSON object described.",
].join("\n");
for (const structured of [true, false]) {
  const started = performance.now();
  try {
    const { value, calls } = await askJson(deps, {
      agent: "screener",
      system: SCREENER_SYSTEM,
      prompt,
      schema: ScreenerAnswerSchema,
      ...(structured ? { jsonSchema: SCREENER_JSON_SCHEMA } : {}),
    });
    console.log(
      `structured=${structured}: OK in ${Math.round(performance.now() - started)} ms, ${calls.length} call(s), model ${calls.at(-1)?.model_routed}, signals ${value.risk_signals.length}, documentary ${value.documentary_evidence.length}`,
    );
  } catch (err) {
    console.log(
      `structured=${structured}: FAILED in ${Math.round(performance.now() - started)} ms: ${String(err).slice(0, 200)}`,
    );
  }
}
process.exit(0);

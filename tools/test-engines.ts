/**
 * Run the official conformance runners of the Meterless engines against this repository's implementations
 * (H-MEM, World Model, Markovian), and the official Scout Intent eval harness against its implementation.
 *
 *   npm run test:engines
 *
 * The runners are vendored in packages/engines/conformance, copied without change from the Meterless engines
 * repository, so no other checkout is needed. Set METERLESS_ENGINES_DIR to run against a newer upstream copy
 * instead. The runners load an implementation from an environment variable (HMEM_IMPL, WORLD_MODEL_IMPL,
 * MARKOVIAN_IMPL) and are run through tsx.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot } from "@sanctions-desk/shared";

const root = projectRoot();
const upstream = process.env.METERLESS_ENGINES_DIR;
const enginesDir = upstream ? resolve(upstream) : undefined;
const TIMEOUT_MS = 120_000;

const suites = [
  { name: "H-MEM", folder: "hmem", variable: "HMEM_IMPL", impl: "packages/engines/src/hmem/index.ts" },
  {
    name: "World Model",
    folder: "world-model",
    variable: "WORLD_MODEL_IMPL",
    impl: "packages/engines/src/world-model/index.ts",
  },
  {
    name: "Markovian",
    folder: "markovian",
    variable: "MARKOVIAN_IMPL",
    impl: "packages/engines/src/markovian/index.ts",
  },
] as const;

let failed = 0;
for (const suite of suites) {
  const runner = enginesDir
    ? join(enginesDir, "engines", suite.folder, "conformance", "runner.ts")
    : join(root, "packages", "engines", "conformance", suite.folder, "runner.ts");
  if (!existsSync(runner)) {
    console.error(`${suite.name}: conformance runner not found at ${runner}`);
    failed += 1;
    continue;
  }
  const result = spawnSync("npx", ["tsx", runner], {
    cwd: root,
    env: { ...process.env, [suite.variable]: join(root, suite.impl) },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const summary = /(\d+)\/(\d+) checks passed/.exec(output);
  const status = result.status === 0 ? "PASS" : "FAIL";
  console.log(`${status} ${suite.name}: ${summary ? `${summary[1]}/${summary[2]} checks passed` : "no scorecard"}`);
  if (result.status !== 0) {
    failed += 1;
    console.log(output);
  }
}
// Scout Intent ships an eval harness instead of a check list: it scores the 32-example regression set against its
// thresholds and exits non-zero when a metric falls below its floor. It writes its report under its own folder.
{
  const runner = enginesDir
    ? join(enginesDir, "engines", "scout-intent", "evals", "runner", "index.ts")
    : join(root, "packages", "engines", "conformance", "scout-intent", "runner", "index.ts");
  const result = spawnSync("npx", ["tsx", runner, "all"], {
    cwd: root,
    env: { ...process.env, SCOUT_IMPL: join(root, "packages/engines/src/scout-intent/index.ts") },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const loaded = /Loaded (\d+) examples/.exec(output)?.[1] ?? "?";
  const status = result.status === 0 ? "PASS" : "FAIL";
  console.log(`${status} Scout Intent: eval gate ${result.status === 0 ? "passed" : "failed"} on ${loaded} examples`);
  if (result.status !== 0) {
    failed += 1;
    console.log(output);
  }
}
process.exit(failed > 0 ? 1 : 0);

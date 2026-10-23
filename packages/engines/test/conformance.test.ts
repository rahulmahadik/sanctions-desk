import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { projectRoot } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";

/**
 * The official Meterless conformance suites, vendored in packages/engines/conformance, run against this repository's
 * engines. No other checkout is needed. The scorecard of each is asserted, so a changed engine that loses a check
 * fails here and in CI.
 */
const root = projectRoot();
const suites = [
  { name: "H-MEM", folder: "hmem", variable: "HMEM_IMPL", impl: "hmem", checks: 13 },
  { name: "World Model", folder: "world-model", variable: "WORLD_MODEL_IMPL", impl: "world-model", checks: 8 },
  { name: "Markovian", folder: "markovian", variable: "MARKOVIAN_IMPL", impl: "markovian", checks: 8 },
] as const;

describe("the Meterless conformance suites against our engines", () => {
  it.each(suites)(
    "$name passes all $checks checks",
    ({ folder, variable, impl, checks }) => {
      const result = spawnSync("npx", ["tsx", join(root, "packages", "engines", "conformance", folder, "runner.ts")], {
        cwd: root,
        env: { ...process.env, [variable]: join(root, "packages", "engines", "src", impl, "index.ts") },
        encoding: "utf8",
        timeout: 120_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`${checks}/${checks} checks passed`);
      expect(result.status).toBe(0);
    },
    150_000,
  );
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  type Generator,
  loadConfig,
  loadPolicyFile,
  PolicyStore,
  RunEventBus,
} from "@sanctions-desk/shared";
import { afterEach } from "vitest";
import { type App, buildApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import type { DependencyProber } from "../src/probes.js";

const dirs: string[] = [];
const apps: App[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sanctions-desk-api-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface TestAppOptions {
  env?: Record<string, string>;
  overrides?: Record<string, unknown>;
  prober?: DependencyProber;
}

const unusedGenerator: Generator = async () => {
  throw new Error("the generator must not be called by these routes");
};

/** Build the real app with quiet logging and a temp log directory. */
export async function makeApp(
  opts: TestAppOptions = {},
): Promise<{ app: App; config: Config; logDir: string; bus: RunEventBus; policies: PolicyStore }> {
  const dir = tempDir();
  const logDir = join(dir, "logs");
  const overridesPath = join(dir, "overrides.json");
  writeFileSync(overridesPath, JSON.stringify({ logging: { stdout: false, dir: logDir }, ...opts.overrides }));

  const config = loadConfig({ env: opts.env ?? {}, overridesPath });
  const bus = new RunEventBus({ replayLimit: config.events.replayLimit, maxRuns: config.events.maxRuns });
  const policies = new PolicyStore(loadPolicyFile(config.policy.file));
  const app = await buildApp({
    config,
    logger: createLogger(config),
    generator: unusedGenerator,
    bus,
    policies,
    prober: opts.prober,
  });
  apps.push(app);
  return { app, config, logDir, bus, policies };
}

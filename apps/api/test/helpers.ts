import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthMode,
  type Config,
  type Generator,
  loadConfig,
  loadPolicyFile,
  PolicyStore,
  RunEventBus,
  type UsersFile,
} from "@sanctions-desk/shared";
import { createZetarisClient, type ZetarisClient } from "@sanctions-desk/zetaris";
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
  generator?: Generator;
  zetaris?: ZetarisClient;
  sampleNotice?: string;
  /** Most tests run with no sign-in. The auth tests set the mode and the users. */
  authMode?: AuthMode;
  users?: UsersFile;
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
  writeFileSync(
    overridesPath,
    JSON.stringify({
      logging: { stdout: false, dir: logDir },
      actions: { outboxDir: join(dir, "outbox") },
      ...opts.overrides,
    }),
  );

  const config = loadConfig({ env: opts.env ?? {}, overridesPath });
  const bus = new RunEventBus({ replayLimit: config.events.replayLimit, maxRuns: config.events.maxRuns });
  const policies = new PolicyStore({ ...loadPolicyFile(config.policy.file), version: 1 });
  const app = await buildApp({
    config,
    logger: createLogger(config),
    generator: opts.generator ?? unusedGenerator,
    zetaris:
      opts.zetaris ??
      createZetarisClient({
        config,
        fetchImpl: async () => new Response('{"msg":"no data service in this test"}', { status: 503 }),
      }),
    bus,
    policies,
    prober: opts.prober,
    sampleNotice: opts.sampleNotice,
    authMode: opts.authMode ?? "off",
    users: opts.users,
  });
  apps.push(app);
  return { app, config, logDir, bus, policies };
}

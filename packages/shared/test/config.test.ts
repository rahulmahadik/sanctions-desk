import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  projectRoot,
  resolveProjectPath,
  secretValues,
} from "../src/index.js";
import { tempDir, testConfig, writeJson } from "./helpers.js";

describe("loadConfig", () => {
  it("loads the committed defaults with no environment", () => {
    const cfg = testConfig();
    expect(cfg.server.port).toBe(8000);
    expect(cfg.sampleMode).toBe(false);
    expect(cfg.nightshift.models.fast).toBe("meterless/fast");
    expect(cfg.limits.criticMaxRounds).toBe(3);
    expect(cfg.zetaris.apiKey).toBeUndefined();
  });

  it("lets environment variables override defaults and coerces types", () => {
    const cfg = testConfig({
      PORT: "9100",
      SAMPLE_MODE: "TRUE",
      METERLESS_BASE_URL: "http://nightshift.internal:9000/v1",
      METERLESS_MODEL_JUDGE: "meterless/text.deep",
    });
    expect(cfg.server.port).toBe(9100);
    expect(cfg.sampleMode).toBe(true);
    expect(cfg.nightshift.baseUrl).toBe("http://nightshift.internal:9000/v1");
    expect(cfg.nightshift.models.judge).toBe("meterless/text.deep");
  });

  it("treats blank environment values as unset", () => {
    const cfg = testConfig({ PORT: "   ", METERLESS_MODEL_FAST: "" });
    expect(cfg.server.port).toBe(8000);
    expect(cfg.nightshift.models.fast).toBe("meterless/fast");
  });

  it("applies an overrides file between the defaults and the environment", () => {
    const dir = tempDir();
    const overrides = writeJson(dir, "prod.json", { server: { port: 7000 }, logging: { level: "warn" } });
    const cfg = loadConfig({ env: { PORT: "7100" }, overridesPath: overrides });
    expect(cfg.logging.level).toBe("warn");
    expect(cfg.server.port).toBe(7100);
  });

  it("reads the overrides file named by CONFIG_FILE", () => {
    const dir = tempDir();
    const overrides = writeJson(dir, "c.json", { limits: { criticMaxRounds: 2 } });
    expect(loadConfig({ env: { CONFIG_FILE: overrides } }).limits.criticMaxRounds).toBe(2);
  });

  it("wraps secrets so they cannot be serialised or printed", () => {
    const cfg = testConfig({
      ZETARIS_API_KEY: "zk-super-secret-1234",
      METERLESS_RUNTIME_TOKEN: "rt-super-secret-5678",
    });
    expect(cfg.zetaris.apiKey?.reveal()).toBe("zk-super-secret-1234");
    const dump = `${JSON.stringify(cfg)} ${inspect(cfg, { depth: 6 })} ${String(cfg.nightshift.runtimeToken)}`;
    expect(dump).not.toContain("super-secret");
    expect(secretValues(cfg)).toEqual(["zk-super-secret-1234", "rt-super-secret-5678"]);
  });

  it("describes the config without revealing secrets", () => {
    const cfg = testConfig({ ZETARIS_API_KEY: "zk-super-secret-1234" });
    const described = describeConfig(cfg);
    expect(described.zetaris.apiKeySet).toBe(true);
    expect(described.nightshift.runtimeTokenSet).toBe(false);
    expect(JSON.stringify(described)).not.toContain("super-secret");
  });

  it("refuses secrets set in a config file", () => {
    const dir = tempDir();
    const overrides = writeJson(dir, "bad.json", { nightshift: { runtimeToken: "leaked-token-value" } });
    expect(() => loadConfig({ env: {}, overridesPath: overrides })).toThrow(/must not be set in the CONFIG_FILE/);
  });

  it("rejects invalid values without echoing them", () => {
    let error: unknown;
    try {
      testConfig({ PORT: "not-a-number", SAMPLE_MODE: "maybe" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("PORT must be a number");
    expect(message).toContain("SAMPLE_MODE must be");
    expect(message).not.toContain("not-a-number");
  });

  it("rejects out-of-range and malformed settings", () => {
    expect(() => testConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(() => testConfig({ METERLESS_BASE_URL: "not a url" })).toThrow(/nightshift\.baseUrl/);
    expect(() => testConfig({ LOG_LEVEL: "loud" })).toThrow(/logging\.level/);
  });

  it("rejects unknown keys so typos do not pass silently", () => {
    const dir = tempDir();
    const overrides = writeJson(dir, "typo.json", { server: { prot: 1 } });
    expect(() => loadConfig({ env: {}, overridesPath: overrides })).toThrow(ConfigError);
  });

  it("never accepts meterless/auto or a non-Meterless id for a lane", () => {
    for (const bad of ["meterless/auto", "nvidia/nemotron-3-super-120b-a12b", "fast", "meterless/", "meterless/Auto"]) {
      expect(() => testConfig({ METERLESS_MODEL_DEEP: bad }), bad).toThrow(/nightshift\.models\.deep/);
    }
    expect(testConfig({ METERLESS_MODEL_JUDGE: "meterless/text.deep" }).nightshift.models.judge).toBe(
      "meterless/text.deep",
    );
  });

  it("ignores the retired METERLESS_MODEL variable instead of using it as a default", () => {
    const cfg = testConfig({ METERLESS_MODEL: "meterless/auto" });
    expect(cfg.nightshift.models).toEqual({ fast: "meterless/fast", deep: "meterless/deep", judge: "meterless/judge" });
  });

  it("reads pinned receipt public keys from a comma separated variable and validates them", () => {
    const key = "00OsSOXGbDitkESZueIJqDPdf9bXAvyrL+8cYDbY6II=";
    expect(testConfig().nightshift.receiptPublicKeys).toEqual([]);
    expect(testConfig({ METERLESS_RECEIPT_PUBLIC_KEY: `${key}, ${key}` }).nightshift.receiptPublicKeys).toEqual([
      key,
      key,
    ]);
    expect(() => testConfig({ METERLESS_RECEIPT_PUBLIC_KEY: "not-a-key" })).toThrow(/receiptPublicKeys/);
  });

  it("reports unreadable and invalid config files", () => {
    const dir = tempDir();
    expect(() => loadConfig({ env: {}, overridesPath: `${dir}/missing.json` })).toThrow(/cannot read config file/);
    const notObject = writeJson(dir, "array.json", [1, 2]);
    expect(() => loadConfig({ env: {}, overridesPath: notObject })).toThrow(/not a valid JSON object/);
  });
});

describe("project-relative paths", () => {
  it("resolves the log folder from the project root, not from the working directory", () => {
    const cfg = testConfig();
    expect(isAbsolute(cfg.logging.dir)).toBe(true);
    expect(cfg.logging.dir).toBe(join(projectRoot(), "logs"));
  });

  it("keeps an absolute log folder as given", () => {
    expect(testConfig({ LOG_DIR: "/var/log/sanctions-desk" }).logging.dir).toBe("/var/log/sanctions-desk");
  });

  it("finds the project root from the config location", () => {
    expect(existsSync(join(projectRoot(), "config", "default.json"))).toBe(true);
    expect(resolveProjectPath(".env")).toBe(join(projectRoot(), ".env"));
  });
});

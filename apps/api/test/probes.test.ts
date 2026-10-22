import { loadConfig } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { mapError } from "../src/errors.js";
import { createDependencyProber } from "../src/probes.js";

function stub(handler: (url: string, init: RequestInit) => Response | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const out = handler(url, init ?? {});
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetchImpl, calls };
}

describe("createDependencyProber", () => {
  const cfg = loadConfig({ env: { METERLESS_RUNTIME_TOKEN: "rt-probe-token-123456", ZETARIS_API_KEY: "zk-probe-key-123456" } });

  it("lists models on both runtimes and sends the Nightshift identity headers", async () => {
    const { fetchImpl, calls } = stub(() => new Response("{}", { status: 200 }));
    const result = await createDependencyProber(cfg, fetchImpl)();
    expect(result.nightshift.state).toBe("ok");
    expect(result.ollama.state).toBe("ok");
    expect(result.zetaris.state).toBe("ok");
    const nightshiftCall = calls.find((c) => c.url.startsWith(cfg.nightshift.baseUrl));
    expect(nightshiftCall?.url).toBe(`${cfg.nightshift.baseUrl}/models`);
    expect(nightshiftCall?.headers["meterless-app"]).toBe(cfg.nightshift.appId);
    const ollamaCall = calls.find((c) => c.url.startsWith(cfg.ollama.baseUrl));
    expect(ollamaCall?.headers["Authorization"]).toBeUndefined();
  });

  it("distinguishes unauthorized, unreachable and unconfigured", async () => {
    const { fetchImpl } = stub((url) =>
      url.startsWith(cfg.nightshift.baseUrl) ? new Response("no", { status: 401 }) : new Error("ECONNREFUSED"),
    );
    const result = await createDependencyProber(cfg, fetchImpl)();
    expect(result.nightshift.state).toBe("unauthorized");
    expect(result.ollama).toMatchObject({ state: "unreachable", detail: "network" });

    const bare = loadConfig({ env: {} });
    const none = await createDependencyProber(bare, stub(() => new Response("{}", { status: 500 })).fetchImpl)();
    expect(none.nightshift.state).toBe("not_configured");
    expect(none.ollama).toMatchObject({ state: "unreachable", detail: "HTTP 500" });
    expect(none.zetaris.state).toBe("not_configured");
  });

  it("never puts secrets in the report", async () => {
    const { fetchImpl } = stub(() => new Response("{}", { status: 200 }));
    const text = JSON.stringify(await createDependencyProber(cfg, fetchImpl)());
    expect(text).not.toContain("probe-token");
    expect(text).not.toContain("probe-key");
  });
});

describe("mapError", () => {
  it("hides internal error messages from callers", () => {
    const { statusCode, error } = mapError(new Error("database password is hunter2"));
    expect(statusCode).toBe(500);
    expect(error.message).toBe("internal server error");
  });
});

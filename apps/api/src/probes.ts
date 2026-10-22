import { type Config, type FetchLike, httpRequest, toStructuredError } from "@sanctions-desk/shared";

export type ProbeState = "ok" | "unreachable" | "unauthorized" | "not_configured";

export interface ProbeResult {
  state: ProbeState;
  latencyMs?: number;
  detail?: string;
}

export interface DependencyReport {
  nightshift: ProbeResult;
  ollama: ProbeResult;
  zetaris: ProbeResult;
}

export type DependencyProber = () => Promise<DependencyReport>;

/** Probe the model runtimes by listing their models. Used by the readiness endpoint. */
export function createDependencyProber(cfg: Config, fetchImpl?: FetchLike): DependencyProber {
  const timeoutMs = cfg.limits.healthProbeTimeoutMs;

  const modelList = async (baseUrl: string, headers: Record<string, string>): Promise<ProbeResult> => {
    try {
      const res = await httpRequest(`${baseUrl.replace(/\/+$/, "")}/models`, { headers, timeoutMs, fetchImpl });
      if (res.status === 401 || res.status === 403) return { state: "unauthorized", latencyMs: Math.round(res.ms) };
      if (res.status >= 200 && res.status < 300) return { state: "ok", latencyMs: Math.round(res.ms) };
      return { state: "unreachable", detail: `HTTP ${res.status}` };
    } catch (err) {
      return { state: "unreachable", detail: toStructuredError(err).type };
    }
  };

  return async () => {
    const token = cfg.nightshift.runtimeToken;
    const [nightshift, ollama] = await Promise.all([
      token
        ? modelList(cfg.nightshift.baseUrl, {
            Authorization: `Bearer ${token.reveal()}`,
            "meterless-app": cfg.nightshift.appId,
            "meterless-scope": cfg.nightshift.scope,
          })
        : Promise.resolve<ProbeResult>({ state: "not_configured", detail: "runtime token not set" }),
      modelList(cfg.ollama.baseUrl, {}),
    ]);
    // The Zetaris adapter arrives in milestone M2; until then only configuration is reported.
    const zetaris: ProbeResult = cfg.zetaris.apiKey
      ? { state: "ok", detail: "configured (not probed yet)" }
      : { state: "not_configured", detail: "api key not set" };
    return { nightshift, ollama, zetaris };
  };
}

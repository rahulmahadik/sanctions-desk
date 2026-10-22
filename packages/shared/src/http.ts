import { AppError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResult {
  status: number;
  text: string;
  ms: number;
}

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/** fetch with a hard timeout. Every external call in this project goes through here. */
export async function httpRequest(url: string, opts: HttpOptions): Promise<HttpResult> {
  const f: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);
  const onCallerAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const start = performance.now();
  try {
    const res = await f(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text, ms: performance.now() - start };
  } catch (err) {
    const ms = performance.now() - start;
    if (opts.signal?.aborted) throw new AppError("network", "request aborted by caller", { recoverable: false });
    if (controller.signal.aborted) {
      throw new AppError("timeout", `request timed out after ${opts.timeoutMs} ms`, {
        recoverable: true,
        details: { url: stripQuery(url), ms: Math.round(ms) },
      });
    }
    const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new AppError("network", `network error: ${reason}`, { recoverable: true, details: { url: stripQuery(url) } });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

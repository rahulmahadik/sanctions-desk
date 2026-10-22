import { describe, expect, it } from "vitest";
import { AppError, httpRequest } from "../src/index.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const URL_UNDER_TEST = "http://upstream.test/v1/thing?secret=1";

describe("httpRequest", () => {
  it("returns status, body text and timing, sending JSON bodies with a content type", async () => {
    const { fetchImpl, calls } = stubFetch([jsonResponse({ ok: true })]);
    const res = await httpRequest(URL_UNDER_TEST, { method: "POST", body: { a: 1 }, timeoutMs: 1000, fetchImpl });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true });
    expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe('{"a":1}');
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("times out with a recoverable error and strips the query string from details", async () => {
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const error = await httpRequest(URL_UNDER_TEST, { timeoutMs: 20, fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    const app = error as AppError;
    expect(app.type).toBe("timeout");
    expect(app.recoverable).toBe(true);
    expect(JSON.stringify(app.details)).not.toContain("secret=1");
  });

  it("maps connection failures to a recoverable network error", async () => {
    const { fetchImpl } = stubFetch([new Error("connect ECONNREFUSED")]);
    const error = (await httpRequest(URL_UNDER_TEST, { timeoutMs: 1000, fetchImpl }).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(error.type).toBe("network");
    expect(error.recoverable).toBe(true);
  });

  it("stops when the caller aborts and reports it as not recoverable", async () => {
    const controller = new AbortController();
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const pending = httpRequest(URL_UNDER_TEST, { timeoutMs: 5000, signal: controller.signal, fetchImpl });
    controller.abort();
    const error = (await pending.catch((e: unknown) => e)) as AppError;
    expect(error.type).toBe("network");
    expect(error.recoverable).toBe(false);
  });
});

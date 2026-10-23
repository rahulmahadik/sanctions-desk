import { AppError, type ErrorType, type StructuredError, toStructuredError } from "@sanctions-desk/shared";
import type { FastifyError } from "fastify";

const STATUS_BY_TYPE: Record<ErrorType, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  not_found: 404,
  not_implemented: 501,
  rate_limited: 429,
  config_missing: 503,
  timeout: 504,
  network: 502,
  http_error: 502,
  bad_response: 502,
  route_dead: 502,
  query_failed: 502,
  guard_blocked: 403,
  internal: 500,
};

export interface MappedError {
  statusCode: number;
  error: StructuredError;
}

/** Turn anything thrown inside a request into an HTTP status and a structured error body. */
export function mapError(err: unknown): MappedError {
  if (err instanceof AppError) {
    return { statusCode: STATUS_BY_TYPE[err.type], error: err.toJSON() };
  }
  const fastifyError = err as Partial<FastifyError> | undefined;
  const status = fastifyError?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return {
      statusCode: status,
      error: {
        type: "validation",
        message: status === 413 ? "request body is too large" : (fastifyError?.message ?? "invalid request"),
        recoverable: false,
      },
    };
  }
  // Unknown failures never leak internals to the caller; details go to the server log instead.
  return { statusCode: 500, error: { ...toStructuredError(err), message: "internal server error" } };
}

/** Structured errors. Every failure that crosses a boundary is an AppError, never a bare string. */

export type ErrorType =
  | "config_missing"
  | "timeout"
  | "network"
  | "http_error"
  | "bad_response"
  | "route_dead"
  | "query_failed"
  | "guard_blocked"
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "not_found"
  | "not_implemented"
  | "internal";

export interface StructuredError {
  type: ErrorType;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly type: ErrorType;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    type: ErrorType,
    message: string,
    opts: { recoverable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.type = type;
    this.recoverable = opts.recoverable ?? false;
    this.details = opts.details;
  }

  toJSON(): StructuredError {
    return {
      type: this.type,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof AppError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { type: "internal", message, recoverable: false };
}

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "./errors.js";
import type { Redactor } from "./redact.js";
import { RunIdSchema, type TraceEvent, type TraceEventInput, TraceEventSchema } from "./schemas.js";

export interface TraceLogger {
  readonly runId: string;
  readonly file: string;
  log(event: TraceEventInput): TraceEvent;
}

export interface TraceOptions {
  runId: string;
  dir: string;
  redact?: Redactor;
  /** Echo every line to stdout (default true). Tests turn this off. */
  stdout?: boolean;
  now?: () => Date;
}

/**
 * Append-only JSONL trace for one run: logs/trace-<run_id>.jsonl.
 * Every line is schema-checked and secret-redacted before it is written.
 */
export function createTraceLogger(opts: TraceOptions): TraceLogger {
  const parsedId = RunIdSchema.safeParse(opts.runId);
  if (!parsedId.success)
    throw new AppError("validation", "invalid run_id for trace file", { details: { run_id: opts.runId } });

  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `trace-${opts.runId}.jsonl`);
  const redact = opts.redact ?? (<T>(v: T) => v);
  const now = opts.now ?? (() => new Date());
  const echo = opts.stdout ?? true;
  let seq = 0;

  return {
    runId: opts.runId,
    file,
    log(input: TraceEventInput): TraceEvent {
      const event = TraceEventSchema.parse(
        redact({ ...input, ts: now().toISOString(), run_id: opts.runId, seq: seq++ }),
      );
      const line = JSON.stringify(event);
      appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o640 });
      if (echo) process.stdout.write(`${line}\n`);
      return event;
    },
  };
}

export function readTrace(file: string): TraceEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => TraceEventSchema.parse(JSON.parse(l)));
}

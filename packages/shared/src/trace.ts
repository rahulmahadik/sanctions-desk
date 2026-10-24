import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "./errors.js";
import type { RunEventBus } from "./events.js";
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
  /** Echo one short readable line per event instead of the JSON line (TRACE_STDOUT_PRETTY). The file is unchanged. */
  pretty?: boolean;
  /** Every event written is also published here, so live views see exactly what the file records. */
  bus?: Pick<RunEventBus, "publish">;
  /** The policy version this run is pinned to; stamped on every event that does not set its own. */
  policyVersion?: number;
  now?: () => Date;
}

/** Fields every written line carries, set to null when they do not apply to the event. */
const ALWAYS_PRESENT = [
  "run_id",
  "action",
  "input_summary",
  "output_summary",
  "target_agent",
  "confidence",
  "retry_count",
  "status",
] as const;

/** Every field a written trace line carries, whatever the event: the event's own fields plus the common names. */
export const TRACE_LINE_FIELDS = ["ts", "timestamp", "seq", "agent", "agent_name", "model", ...ALWAYS_PRESENT] as const;

/** The model an event names: the model that answered, else the routed model a step recorded in its detail. */
function modelOf(event: TraceEvent): string | null {
  if (event.model_used !== undefined) return event.model_used;
  const routed = event.detail?.model_routed;
  return typeof routed === "string" ? routed : null;
}

/**
 * The line written for an event: every field of the event, unchanged, plus the common names other tools read
 * (`agent_name`, `model`, `timestamp`) and null for the always-present fields the event does not set.
 */
export function traceLine(event: TraceEvent): Record<string, unknown> {
  const line: Record<string, unknown> = { ...event };
  for (const key of ALWAYS_PRESENT) if (line[key] === undefined) line[key] = null;
  line.agent_name = event.agent;
  line.model = modelOf(event);
  line.timestamp = event.ts;
  return line;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** One short readable line for a person watching a run: time, agent, action, status, summary, and for a model call the
 * model asked for, the model that served it and the receipt id, side by side even when they differ. */
export function prettyTraceLine(event: TraceEvent): string {
  const time = event.ts.slice(11, 19);
  const summary = clip((event.output_summary ?? event.input_summary ?? "").replaceAll("\n", " "), 100);
  const parts = [time, event.agent.padEnd(12), event.action.padEnd(24), event.status.padEnd(7), summary];
  if (event.model_requested) parts.push(`requested=${event.model_requested}`);
  if (event.model_used) parts.push(`routed=${event.model_used}`);
  if (event.receipt) parts.push(`receipt=${event.receipt.receipt_id}`);
  return parts.join(" ").trimEnd();
}

/** Read a written line back as an event: drop the common names and the nulls added for absent fields. */
function fromLine(raw: Record<string, unknown>): unknown {
  const { agent_name: _a, model: _m, timestamp: _t, ...rest } = raw;
  for (const key of ALWAYS_PRESENT) if (rest[key] === null) delete rest[key];
  return rest;
}

/**
 * Append-only JSONL trace for one run: logs/trace-<run_id>.jsonl.
 * Every event is schema-checked and secret-redacted once, then written to the file (with the common field
 * names added, see traceLine), echoed to stdout and published on the event bus.
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
  const pretty = opts.pretty ?? false;
  let seq = 0;

  return {
    runId: opts.runId,
    file,
    log(input: TraceEventInput): TraceEvent {
      const stamped = {
        ...(opts.policyVersion !== undefined ? { policy_version: opts.policyVersion } : {}),
        ...input,
        ts: now().toISOString(),
        run_id: opts.runId,
        seq,
      };
      const event = TraceEventSchema.parse(redact(stamped));
      seq += 1;
      const line = JSON.stringify(traceLine(event));
      appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o640 });
      if (echo) process.stdout.write(`${pretty ? prettyTraceLine(event) : line}\n`);
      opts.bus?.publish(event);
      return event;
    },
  };
}

export function readTrace(file: string): TraceEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => TraceEventSchema.parse(fromLine(JSON.parse(l) as Record<string, unknown>)));
}

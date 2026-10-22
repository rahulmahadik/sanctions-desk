import type { RunEvent } from "./schemas.js";

/**
 * In-process run event bus.
 *
 * Every event written to a run's trace is also published here (see `createTraceLogger`). The live
 * view (server-sent events), the model-routing panel and the replay scrubber all read from this one
 * stream, so nothing is instrumented twice and nothing on screen can be invented.
 */

export type RunEventListener = (event: RunEvent) => void;
export type Unsubscribe = () => void;

/** Subscribe to this id to receive the events of every run. */
export const ALL_RUNS = "*";

/** Actions by which the `system` agent closes a run. After one of these no more events follow. */
export const TERMINAL_ACTIONS: readonly string[] = ["run_completed", "run_failed", "run_rejected"];

export function isTerminalEvent(event: RunEvent): boolean {
  return event.agent === "system" && TERMINAL_ACTIONS.includes(event.action);
}

export interface RunEventBusOptions {
  /** Events kept per run for late subscribers. Older events are dropped first. */
  replayLimit: number;
  /** Runs kept in memory. The oldest finished run is dropped first, then the oldest run. */
  maxRuns: number;
  /** Called when a subscriber throws. A failing subscriber never affects the run or other subscribers. */
  onListenerError?: (error: unknown, event: RunEvent) => void;
}

interface RunBuffer {
  events: RunEvent[];
  dropped: number;
  finished: boolean;
}

export interface SubscribeOptions {
  /** Deliver the buffered history of the run before live events (default true; ignored for ALL_RUNS). */
  replay?: boolean;
}

export class RunEventBus {
  readonly #runs = new Map<string, RunBuffer>();
  readonly #listeners = new Map<string, Set<RunEventListener>>();
  readonly #opts: RunEventBusOptions;

  constructor(opts: RunEventBusOptions) {
    if (!Number.isInteger(opts.replayLimit) || opts.replayLimit < 1) throw new RangeError("replayLimit must be >= 1");
    if (!Number.isInteger(opts.maxRuns) || opts.maxRuns < 1) throw new RangeError("maxRuns must be >= 1");
    this.#opts = opts;
  }

  publish(event: RunEvent): void {
    const buffer = this.#bufferFor(event.run_id);
    buffer.events.push(event);
    if (buffer.events.length > this.#opts.replayLimit) {
      buffer.events.shift();
      buffer.dropped += 1;
    }
    if (isTerminalEvent(event)) buffer.finished = true;
    this.#evictIfNeeded(event.run_id);

    this.#deliver(this.#listeners.get(event.run_id), event);
    this.#deliver(this.#listeners.get(ALL_RUNS), event);
  }

  subscribe(runId: string, listener: RunEventListener, options: SubscribeOptions = {}): Unsubscribe {
    if (runId !== ALL_RUNS && (options.replay ?? true)) {
      for (const event of this.history(runId)) this.#deliverOne(listener, event);
    }
    const set = this.#listeners.get(runId) ?? new Set<RunEventListener>();
    set.add(listener);
    this.#listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#listeners.get(runId) === set) this.#listeners.delete(runId);
    };
  }

  /** Buffered events of a run, oldest first. */
  history(runId: string): readonly RunEvent[] {
    return [...(this.#runs.get(runId)?.events ?? [])];
  }

  /** How many early events of a run were dropped because the replay limit was reached. */
  droppedCount(runId: string): number {
    return this.#runs.get(runId)?.dropped ?? 0;
  }

  isFinished(runId: string): boolean {
    return this.#runs.get(runId)?.finished ?? false;
  }

  hasRun(runId: string): boolean {
    return this.#runs.has(runId);
  }

  listenerCount(runId: string): number {
    return this.#listeners.get(runId)?.size ?? 0;
  }

  #bufferFor(runId: string): RunBuffer {
    let buffer = this.#runs.get(runId);
    if (!buffer) {
      buffer = { events: [], dropped: 0, finished: false };
      this.#runs.set(runId, buffer);
    }
    return buffer;
  }

  #evictIfNeeded(protectedRunId: string): void {
    while (this.#runs.size > this.#opts.maxRuns) {
      const candidates = [...this.#runs.entries()].filter(([id]) => id !== protectedRunId);
      const victim = candidates.find(([, b]) => b.finished) ?? candidates[0];
      if (!victim) return;
      this.#runs.delete(victim[0]);
    }
  }

  #deliver(listeners: Set<RunEventListener> | undefined, event: RunEvent): void {
    if (!listeners) return;
    for (const listener of [...listeners]) this.#deliverOne(listener, event);
  }

  #deliverOne(listener: RunEventListener, event: RunEvent): void {
    try {
      listener(event);
    } catch (error) {
      try {
        this.#opts.onListenerError?.(error, event);
      } catch {
        // The error hook itself must never break a run.
      }
    }
  }
}

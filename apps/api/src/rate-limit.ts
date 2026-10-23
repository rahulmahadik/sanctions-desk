import { AppError, type Config } from "@sanctions-desk/shared";

type RateLimitConfig = Config["server"]["rateLimit"];

/** Routes that start a review: they make model calls and data queries, so they get the lower limit. */
export const REVIEW_ROUTES: ReadonlySet<string> = new Set(["POST /run", "POST /policy/whatif"]);

interface Window {
  start: number;
  count: number;
}

/** A refusal: the error for the body and the seconds to put in Retry-After. */
export interface Refusal {
  error: AppError;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters per caller, and a count of reviews running at once. Everything is in memory, so the limits
 * hold per process: several API processes behind one address each apply them on their own.
 */
export class RateLimiter {
  private readonly writes = new Map<string, Window>();
  private readonly reviews = new Map<string, Window>();
  private lastSweep: number;
  private running = 0;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number,
  ) {
    this.lastSweep = now();
  }

  /**
   * Count one request to `route` (for example `POST /run`) by `caller`. Reads are never counted. Returns a refusal
   * when the caller is over a limit; a refused request is not counted.
   */
  check(caller: string, route: string): Refusal | undefined {
    if (!this.config.enabled) return undefined;
    const now = this.now();
    this.sweep(now);
    const review = REVIEW_ROUTES.has(route);
    const writeWindow = this.current(this.writes, caller, now);
    const reviewWindow = review ? this.current(this.reviews, caller, now) : undefined;
    if (reviewWindow && reviewWindow.count >= this.config.reviewsPerWindow) {
      return this.refuse(reviewWindow, now, `at most ${this.config.reviewsPerWindow} reviews per window`);
    }
    if (writeWindow.count >= this.config.writesPerWindow) {
      return this.refuse(writeWindow, now, `at most ${this.config.writesPerWindow} changes per window`);
    }
    writeWindow.count += 1;
    if (reviewWindow) reviewWindow.count += 1;
    return undefined;
  }

  /**
   * Take a slot for a review. Returns the function that frees it, to be called once the review ends however it ends,
   * or a refusal when the configured number of reviews is already running.
   */
  acquireReview(): { release: () => void } | Refusal {
    if (!this.config.enabled) return { release: () => {} };
    if (this.running >= this.config.reviewsInFlight) {
      return {
        error: new AppError(
          "rate_limited",
          `${this.config.reviewsInFlight} reviews are already running; try again shortly`,
          { recoverable: true },
        ),
        retryAfterSeconds: this.config.busyRetryAfterSeconds,
      };
    }
    this.running += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.running -= 1;
      },
    };
  }

  /** Reviews running now. */
  inFlight(): number {
    return this.running;
  }

  private current(map: Map<string, Window>, caller: string, now: number): Window {
    const existing = map.get(caller);
    if (existing && now - existing.start < this.config.windowMs) return existing;
    const fresh = { start: now, count: 0 };
    map.set(caller, fresh);
    return fresh;
  }

  private refuse(window: Window, now: number, rule: string): Refusal {
    const retryAfterSeconds = Math.max(1, Math.ceil((window.start + this.config.windowMs - now) / 1000));
    return {
      error: new AppError("rate_limited", `too many requests (${rule}); try again in ${retryAfterSeconds} s`, {
        recoverable: true,
      }),
      retryAfterSeconds,
    };
  }

  /** Drop windows that have ended, at most once per window length, so the maps do not grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.config.windowMs) return;
    this.lastSweep = now;
    for (const map of [this.writes, this.reviews]) {
      for (const [caller, w] of map) if (now - w.start >= this.config.windowMs) map.delete(caller);
    }
  }
}

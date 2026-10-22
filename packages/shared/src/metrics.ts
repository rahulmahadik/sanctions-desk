import type { GenerateResult } from "./generator.js";

/**
 * Metrics over model calls. Nightshift can answer from its cache in a few milliseconds without
 * running a model, so a cached answer says nothing about speed or cost. Latency and token figures
 * therefore only count calls that actually ran; cached calls are counted and reported separately.
 */

export interface LatencyStats {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface CallSummary {
  total: number;
  cached: number;
  /** Calls whose cache status is unknown (providers that do not report it) count as uncached. */
  uncached: number;
  latencyMs: LatencyStats | null;
  tokensIn: number;
  tokensOut: number;
  byRoute: { local: number; cloud: number; unknown: number };
  byProvider: Record<string, number>;
  modeMismatches: number;
  /** Receipts by verification status. */
  receipts: Record<string, number>;
}

export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) throw new RangeError("percentile of an empty list");
  if (p < 0 || p > 100) throw new RangeError("percentile must be between 0 and 100");
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[Math.max(0, rank - 1)] as number;
}

export function latencyStats(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0] as number,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] as number,
  };
}

export function summarizeCalls(results: readonly GenerateResult[]): CallSummary {
  const uncachedResults = results.filter((r) => r.fromCache !== true);
  const summary: CallSummary = {
    total: results.length,
    cached: results.length - uncachedResults.length,
    uncached: uncachedResults.length,
    latencyMs: latencyStats(uncachedResults.map((r) => r.latencyMs)),
    tokensIn: 0,
    tokensOut: 0,
    byRoute: { local: 0, cloud: 0, unknown: 0 },
    byProvider: {},
    modeMismatches: 0,
    receipts: {},
  };
  for (const r of uncachedResults) {
    summary.tokensIn += r.usage?.promptTokens ?? 0;
    summary.tokensOut += r.usage?.completionTokens ?? 0;
    summary.byRoute[r.routeKind ?? "unknown"] += 1;
  }
  for (const r of results) {
    summary.byProvider[r.provider] = (summary.byProvider[r.provider] ?? 0) + 1;
    if (r.modeMismatch) summary.modeMismatches += 1;
    if (r.receipt) summary.receipts[r.receipt.verification] = (summary.receipts[r.receipt.verification] ?? 0) + 1;
  }
  return summary;
}

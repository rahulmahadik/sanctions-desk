// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Configuration validation and the efficiency arithmetic. Validation throws a typed error; nothing is
// silently truncated or ignored.

import type { ChunkConfig, ChunkInfo } from "./types.js";
import { BOUNDS, ConfigValidationError, DEFAULT_CONFIG, FRAMING_TOKENS, OUTPUT_BUDGET } from "./types.js";

export function resolveConfig(partial?: Partial<ChunkConfig>): ChunkConfig {
  const cfg: ChunkConfig = { ...DEFAULT_CONFIG, ...partial };
  for (const key of ["chunkSize", "maxChunks", "carryoverTokens", "overlapTokens"] as const) {
    const bound = BOUNDS[key];
    const value = cfg[key];
    if (!Number.isFinite(value)) throw new ConfigValidationError(`${key} must be a number`);
    // Only min and max are enforced. The "step" values are slider granularity; a strict step grid would
    // reject the documented default carryoverTokens of 800.
    if (value < bound.min || value > bound.max) {
      throw new ConfigValidationError(`${key}=${value} outside [${bound.min}, ${bound.max}]`);
    }
  }
  if (cfg.chunkSize < FRAMING_TOKENS + cfg.carryoverTokens + OUTPUT_BUDGET) {
    throw new ConfigValidationError(
      `chunkSize=${cfg.chunkSize} < framing(${FRAMING_TOKENS}) + carryover(${cfg.carryoverTokens}) + outputBudget(${OUTPUT_BUDGET})`,
    );
  }
  return cfg;
}

/** Projected efficiency curve, 10 steps by default. */
export function projectionCurve(cfg: ChunkConfig, steps = 10): { step: number; standard: number; markovian: number }[] {
  return Array.from({ length: steps }, (_, i) => ({
    step: i + 1,
    standard: i * cfg.chunkSize + cfg.chunkSize,
    markovian: cfg.carryoverTokens + cfg.chunkSize,
  }));
}

export interface RunEfficiency {
  totalTokensUsed: number;
  standardCost: number;
  markovianCost: number;
  tokensSaved: number;
  efficiencyPercent: number;
}

/**
 * Efficiency of a finished run, always against the configuration passed in, which must be the run's own
 * stored snapshot. The standard cost re-reads the whole prefix at every step; the Markovian cost carries
 * a fixed state instead.
 */
export function runEfficiency(chunks: ChunkInfo[], cfg: ChunkConfig): RunEfficiency {
  const totalTokensUsed = chunks.reduce((s, c) => s + c.tokens, 0);
  let standardCost = 0;
  let prefix = 0;
  for (const c of chunks) {
    standardCost += prefix + c.tokens;
    prefix += c.tokens;
  }
  const markovianCost = chunks.length * cfg.carryoverTokens + totalTokensUsed;
  const tokensSaved = Math.max(0, standardCost - markovianCost);
  return {
    totalTokensUsed,
    standardCost,
    markovianCost,
    tokensSaved,
    efficiencyPercent: standardCost > 0 ? (tokensSaved / standardCost) * 100 : 0,
  };
}

/** Constants of the symbolic cost model: framing, goal, step input, per-step output, carryover. */
export interface CostModelConstants {
  F: number;
  G: number;
  S: number;
  O: number;
  C: number;
}
export const DOC_DEFAULTS: CostModelConstants = { F: 400, G: 200, S: 300, O: 1200, C: 800 };

/**
 * Input-token totals of the symbolic model:
 *   naive     = N*(F + G + S) + O * N*(N-1)/2
 *   markovian = N*(F + G + C + S)
 * With the documented defaults, 20 steps give 246000 and 34000 tokens, about 86% saved.
 */
export function modelTotals(
  n: number,
  k: CostModelConstants = DOC_DEFAULTS,
): { naiveTotal: number; markovianTotal: number; savings: number; efficiency: number } {
  const naiveTotal = n * (k.F + k.G + k.S) + (k.O * n * (n - 1)) / 2;
  const markovianTotal = n * (k.F + k.G + k.C + k.S);
  const savings = naiveTotal - markovianTotal;
  return { naiveTotal, markovianTotal, savings, efficiency: savings / naiveTotal };
}

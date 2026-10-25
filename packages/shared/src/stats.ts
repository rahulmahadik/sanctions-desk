/**
 * The one percentile used everywhere in the desk's reports: nearest rank on the sorted values, so a median or a p95
 * is always a value that was measured (for an even count the median is the lower of the two middle values).
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] as number;
}

export const median = (values: readonly number[]): number => percentile(values, 50);

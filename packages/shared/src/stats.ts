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

/**
 * The 95% Wilson score interval for x successes in n trials, as whole percentages. Unlike the plain normal
 * interval it stays inside 0 to 100% and is not zero-width at 0 of n, which matters for counts this small.
 */
export function wilson95(x: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 100 };
  const z = 1.96;
  const p = x / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);
  return { low: pct(centre - half), high: pct(centre + half) };
}

/** "4 of 48 (3–20%)": a count with its 95% Wilson interval, in the plain style the reports use. */
export const countWithInterval = (x: number, n: number): string => {
  const { low, high } = wilson95(x, n);
  return `${x} of ${n} (${low}–${high}%)`;
};

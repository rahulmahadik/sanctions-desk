import type { Metrics } from "./eval.js";

/** A seeded shuffle, so a random batch can be repeated exactly. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** K cases chosen at random but repeatably from the given kinds. */
export function pickBatch<T>(items: readonly T[], k: number, seed: number): T[] {
  const rand = seeded(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, Math.max(0, Math.min(k, copy.length)));
}

export interface BenchRun {
  run: number;
  file?: string;
  ok: boolean;
  error?: string;
  metrics?: Metrics;
}

interface Spread {
  mean: number;
  min: number;
  max: number;
}

const spread = (values: readonly number[]): Spread => {
  if (values.length === 0) return { mean: 0, min: 0, max: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  const r = (n: number) => Math.round(n * 10_000) / 10_000;
  return { mean: r(sum / values.length), min: r(Math.min(...values)), max: r(Math.max(...values)) };
};

export interface BenchSummary {
  runs: number;
  completed: number;
  failed: number;
  cases_per_run: number;
  exact_accuracy: Spread;
  acceptable_accuracy: Spread;
  false_close_rate: Spread;
  false_closes_total: number;
  decision_unavailable_total: number;
  latency_p50_s: Spread;
  /** Calls by the model that served them, across all completed runs. Calls served locally cost nothing per call. */
  model_calls: { local: number; cloud: number };
  /** What the runs cost under the configured unit costs: only cloud tokens are priced. */
  cost: { total: number; per_run: Spread; local_calls_cost: 0 };
  tokens: { in: number; out: number };
}

/** The spread over repeated runs of the same selection, and the totals that matter for cost. */
export function summariseRuns(runs: readonly BenchRun[]): BenchSummary {
  const done = runs.flatMap((r) => (r.ok && r.metrics ? [r.metrics] : []));
  const total = (pick: (m: Metrics) => number) => done.reduce((t, m) => t + pick(m), 0);
  return {
    runs: runs.length,
    completed: done.length,
    failed: runs.length - done.length,
    cases_per_run: done[0]?.cases ?? 0,
    exact_accuracy: spread(done.map((m) => m.exact_accuracy)),
    acceptable_accuracy: spread(done.map((m) => m.acceptable_accuracy)),
    false_close_rate: spread(done.map((m) => m.false_close_rate)),
    false_closes_total: total((m) => m.false_closes),
    decision_unavailable_total: total((m) => m.decision_unavailable),
    latency_p50_s: spread(done.map((m) => m.latency_s.p50)),
    model_calls: { local: total((m) => m.model_calls.local), cloud: total((m) => m.model_calls.cloud) },
    cost: {
      total: Math.round(total((m) => m.cost.total) * 1_000_000) / 1_000_000,
      per_run: spread(done.map((m) => m.cost.total)),
      local_calls_cost: 0,
    },
    tokens: { in: total((m) => m.tokens.in), out: total((m) => m.tokens.out) },
  };
}

/** A short markdown summary of a benchmark, for people. */
export function renderBenchSummary(title: string, selection: string, summary: BenchSummary): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const range = (s: Spread, f: (n: number) => string) => `${f(s.mean)} (${f(s.min)} to ${f(s.max)})`;
  const money = (n: number) => `${n.toFixed(4)}`;
  return [
    `# ${title}`,
    "",
    `Selection: ${selection}. ${summary.completed} of ${summary.runs} runs completed (${summary.cases_per_run} cases each).`,
    "",
    "| Measure | Over the runs |",
    "|---|---|",
    `| Exact answers | ${range(summary.exact_accuracy, pct)} |`,
    `| Acceptable answers | ${range(summary.acceptable_accuracy, pct)} |`,
    `| False-close rate on risk cases | ${range(summary.false_close_rate, pct)}; ${summary.false_closes_total} false closes in total |`,
    `| Escalated because no model decision was usable | ${summary.decision_unavailable_total} in total |`,
    `| Median time per case | ${range(summary.latency_p50_s, (n) => `${n.toFixed(1)} s`)} |`,
    `| Model calls | ${summary.model_calls.local} served by the local model (no API cost), ${summary.model_calls.cloud} served by the cloud model |`,
    `| Tokens | ${summary.tokens.in} in, ${summary.tokens.out} out |`,
    `| Model cost per run | ${range(summary.cost.per_run, money)} (cloud tokens under the configured unit costs; local calls 0) |`,
    `| Model cost, all runs | ${money(summary.cost.total)} |`,
    "",
  ].join("\n");
}

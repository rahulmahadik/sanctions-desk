// Derived from the Meterless World Model reference implementation, Apache-2.0.
// Entity resolution with banded thresholds:
//
//   similarity >= 0.85          auto-merge  (0.85 exactly is an auto-merge)
//   0.82 <= similarity < 0.85   operator review queue (0.82 exactly queues)
//   similarity < 0.82           new entity
//
// Similarity is Levenshtein based: 1 - distance / max(length) on NORMALISED names, so diacritics and
// whitespace never inflate the distance.

import { normalizeName } from "./stable-ids.js";

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

export function nameSimilarity(rawA: string, rawB: string): number {
  const a = normalizeName(rawA);
  const b = normalizeName(rawB);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export type ResolutionDecision = "auto-merge" | "review" | "new";

export function decide(similarity: number, autoMergeAt = 0.85, reviewLower = 0.82): ResolutionDecision {
  if (similarity >= autoMergeAt) return "auto-merge";
  if (similarity >= reviewLower) return "review";
  return "new";
}

/** The clustering gate of the ingest pipeline: entity-overlap Jaccard of 0.5 or more co-clusters. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

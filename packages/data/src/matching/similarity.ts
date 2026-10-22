import { normaliseName } from "../text.js";

/**
 * Name similarity used to raise alerts and to compare a customer with a listed party.
 * Everything here is deterministic and explainable: a score always comes with the method that produced it.
 */

/** Positions in `a` and `b` that match within the Jaro window. */
function matchPositions(a: string, b: string): { a: boolean[]; b: boolean[]; matches: number } {
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched: boolean[] = new Array(a.length).fill(false);
  const bMatched: boolean[] = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const to = Math.min(b.length - 1, i + window);
    for (let j = Math.max(0, i - window); j <= to; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  return { a: aMatched, b: bMatched, matches };
}

function countTranspositions(a: string, b: string, found: { a: boolean[]; b: boolean[] }): number {
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!found.a[i]) continue;
    while (!found.b[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  return transpositions;
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const found = matchPositions(a, b);
  const m = found.matches;
  if (m === 0) return 0;
  const t = countTranspositions(a, b, found);
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function tokensOf(normalised: string): string[] {
  return normalised.split(" ").filter((t) => t.length > 0);
}

const SKELETON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ph/g, "f"],
  [/kh|gh|h/g, "h"],
  [/ck|q|c/g, "k"],
  [/w/g, "v"],
  [/x/g, "ks"],
  [/z/g, "s"],
  [/dj|j/g, "j"],
  [/sch|sh|ch|tch/g, "x"],
  [/[yaeiou]/g, ""],
  [/(.)\1+/g, "$1"],
];

/** A consonant skeleton: spellings of one sound ("Mohammed", "Muhammad") tend to share it. */
export function phoneticSkeleton(token: string): string {
  let out = token;
  for (const [pattern, replacement] of SKELETON_RULES) out = out.replace(pattern, replacement);
  return out;
}

function bestTokenScore(token: string, others: readonly string[]): number {
  let best = 0;
  const skeleton = phoneticSkeleton(token);
  for (const other of others) {
    let score = jaroWinkler(token, other);
    if (skeleton.length >= 2 && skeleton === phoneticSkeleton(other)) score = Math.max(score, 0.93);
    if (score > best) best = score;
  }
  return best;
}

export interface NameScore {
  score: number;
  method: "exact" | "token_set" | "phonetic" | "none";
}

/** Similarity of two names (any case, accents or punctuation) between 0 and 1. */
export function nameScore(left: string, right: string): NameScore {
  const a = normaliseName(left);
  const b = normaliseName(right);
  if (a === "" || b === "") return { score: 0, method: "none" };
  if (a === b) return { score: 1, method: "exact" };
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if ([...ta].sort().join(" ") === [...tb].sort().join(" ")) return { score: 0.98, method: "token_set" };

  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const perToken = short.map((t) => bestTokenScore(t, long));
  const covered = perToken.reduce((s, v) => s + v, 0) / short.length;
  // Unmatched extra tokens on the longer name lower the score a little, never to zero.
  const coverage = short.length / long.length;
  const score = covered * (0.8 + 0.2 * coverage);
  const phonetic = perToken.every((v) => v >= 0.93) && covered >= 0.93;
  return { score: Math.round(score * 1000) / 1000, method: phonetic ? "phonetic" : "token_set" };
}

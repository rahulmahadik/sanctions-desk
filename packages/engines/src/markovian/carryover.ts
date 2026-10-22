// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// State carryover. The compression cascade runs in strict order: marker override, model compression,
// heuristic extraction, tail truncation. Each level falls through on failure, so the chain survives
// model or network trouble.

import type { ChunkConfig } from "./types.js";
import { estimateTokens } from "./types.js";

export type CascadeLevel = "marker" | "llm" | "heuristic" | "truncation";

export interface CarryoverResult {
  carryover: string;
  level: CascadeLevel;
}

const KEY_PHRASE =
  /(?:^|\n|\.\s+)((?:Therefore|Key insight|Status|Decision|Decided|Next|Remaining|Completed)[^.\n]*)/gi;
const MIN_CARRYOVER_CHARS = 24;

export class CarryoverService {
  constructor(private readonly compressorFn?: (prompt: string, systemPrompt: string) => Promise<string>) {}

  async next(args: {
    markerState: string | undefined;
    previousCarryover: string;
    chunkText: string;
    config: ChunkConfig;
  }): Promise<CarryoverResult> {
    const budget = args.config.carryoverTokens;
    const fits = (text: string) => text.length >= MIN_CARRYOVER_CHARS && estimateTokens(text) <= budget;

    // Level 1: the explicit marker state, when long enough and within budget.
    if (args.markerState !== undefined) {
      const sanitized = args.markerState.replace(/[<>[\]@-]{3,}/g, "").trim();
      if (fits(sanitized)) return { carryover: sanitized, level: "marker" };
    }

    // Level 2: model compression through the injected compressor.
    const compressed = await this.compress(args);
    if (compressed !== undefined && fits(compressed)) return { carryover: compressed, level: "llm" };

    // Level 3: key-phrase extraction.
    const phrases = [...args.chunkText.matchAll(KEY_PHRASE)].map((m) => (m[1] ?? "").trim()).slice(0, 5);
    if (phrases.length > 0) {
      const summary = phrases.join("; ");
      if (estimateTokens(summary) <= budget) return { carryover: summary, level: "heuristic" };
    }

    // Level 4: absolute fallback, truncate words from the tail to the token budget.
    return { carryover: tailWithinBudget(args.chunkText || args.previousCarryover, budget), level: "truncation" };
  }

  private async compress(args: { previousCarryover: string; chunkText: string }): Promise<string | undefined> {
    if (!this.compressorFn) return undefined;
    try {
      const preview = args.chunkText.slice(-2000);
      const prompt =
        `Previous state:\n${args.previousCarryover || "(none)"}\n\nLatest chunk (tail):\n${preview}\n\n` +
        "Compress into 3-5 critical points as a labeled block:\nCOMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...";
      return (
        await this.compressorFn(prompt, "You compress reasoning state. Be terse and lossless on decisions.")
      ).trim();
    } catch {
      return undefined;
    }
  }
}

function tailWithinBudget(text: string, budget: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  let tail = "";
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const candidate = tail ? `${words[i]} ${tail}` : (words[i] ?? "");
    if (estimateTokens(candidate) > budget) break;
    tail = candidate;
  }
  return tail;
}

export function canonicalBlock(parts: {
  completed: string;
  remaining: string;
  decisions: string;
  context: string;
}): string {
  return `COMPLETED: ${parts.completed}\nREMAINING: ${parts.remaining}\nDECISIONS: ${parts.decisions}\nCONTEXT: ${parts.context}`;
}

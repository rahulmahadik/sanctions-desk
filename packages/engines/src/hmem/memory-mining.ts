// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Acquisition pipeline. The model-free path is the default: heuristic sentence extraction keeps capture
// going with no model. An optional minerFn takes an extraction prompt and returns a strict JSON array of
// memory strings, parsed robustly (code fences removed, format noise tolerated).

import type { MemoryStoreService } from "./memory-store.js";
import type { MemoryLayer, MemoryRecord, MemoryType, MiningEventType } from "./types.js";

const EVENT_TYPE_MAP: Record<MiningEventType, MemoryType> = {
  chat_message: "general",
  user_correction: "preference",
  file_save: "factual",
  file_open: "general",
  file_edit: "factual",
  model_response: "factual",
  plan_completion: "factual",
};

const SIGNAL = /\b(prefer|always|never|decided|chose|choose|use|because|instead|must|should|important|remember)\b/i;

export class MemoryMiningService {
  constructor(
    private readonly store: MemoryStoreService,
    private readonly clock: () => number,
    private readonly minerFn?: (prompt: string) => Promise<string>,
  ) {}

  async mineInteraction(
    event: MiningEventType,
    text: string,
    opts?: { chatId?: string; layer?: MemoryLayer },
  ): Promise<MemoryRecord[]> {
    const candidates = await this.candidates(event, text);
    return candidates.map((content) =>
      this.store.add({
        content,
        type: EVENT_TYPE_MAP[event],
        layer: opts?.layer ?? (this.minerFn ? "working" : "short_term"),
        tags: [`event:${event}`],
        source: `interaction:${event}`,
        provenance: { origin: event, learnedAt: this.clock(), label: `mined from ${event}` },
        chatId: opts?.chatId,
      }),
    );
  }

  async mineDocument(fileName: string, text: string): Promise<MemoryRecord[]> {
    const truncated = text.slice(0, 8000);
    const candidates = await this.candidates("file_save", truncated);
    return candidates.map((content) =>
      this.store.add({
        content,
        type: "factual",
        layer: "working",
        tags: ["document", `file:${fileName}`],
        source: `document:${fileName}`,
      }),
    );
  }

  private async candidates(event: MiningEventType, text: string): Promise<string[]> {
    if (!this.minerFn) return this.mineModelFree(text);
    const prompt = `Extract durable memories from this ${event} as a strict JSON array of strings:\n\n${text}`;
    return parseStrictJsonArray(await this.minerFn(prompt));
  }

  /** The no-model path: concise direct sentences that carry a signal word. */
  mineModelFree(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20 && s.length <= 300 && SIGNAL.test(s))
      .slice(0, 10);
  }
}

/** Robust parsing: strip code fences, tolerate noise around the array. */
export function parseStrictJsonArray(raw: string): string[] {
  let cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length >= 5);
  } catch {
    return [];
  }
}

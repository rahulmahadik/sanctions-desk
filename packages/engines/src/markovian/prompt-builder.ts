// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Prompt builder. Memory context enters the first chunk only; continuation chunks carry the truncated goal
// and the carryover. When overlapTokens > 0 an [OVERLAP] block follows the carryover: implemented, never
// silently ignored.

import type { Attachment, ChunkConfig, Mode } from "./types.js";

const MARKER_RULES =
  "End every non-final chunk with [STATE_CHECKPOINT] followed by a concise state block:\n" +
  "COMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...\n" +
  "End the final chunk with [TASK_COMPLETE]. Exactly one marker per chunk. Never narrate the markers.";

export interface PromptArgs {
  mode: Mode;
  goal: string;
  /** 1-based. */
  step: number;
  carryover: string;
  /** Pre-sliced by the orchestrator; empty when overlapTokens is 0. */
  overlapText: string;
  memoryContext?: string;
  attachments: Attachment[];
  config: ChunkConfig;
}

export function buildPrompt(args: PromptArgs): string {
  const parts = args.step === 1 ? firstChunk(args) : continuation(args);
  parts.push("", MARKER_RULES);
  return parts.join("\n");
}

function firstChunk(args: PromptArgs): string[] {
  const parts: string[] = [];
  if (args.memoryContext) parts.push(args.memoryContext.trim(), "");
  parts.push(
    args.mode === "ARCHITECT"
      ? "You are executing a long build task in bounded chunks. Analyze the goal, produce a plan, and start implementation."
      : "You are executing recursive research in bounded chunks. Log every action as '>> action'. " +
          "Produce multi-file style output where useful and keep a research-tree state snapshot.",
    "",
    `User Request: ${args.goal}`,
  );
  if (args.attachments.length > 0) {
    parts.push("");
    for (const a of args.attachments) parts.push(`[ATTACHMENT ${a.name}]\n${a.content}`);
  }
  return parts;
}

function continuation(args: PromptArgs): string[] {
  const parts = [
    `Continuing a chunked ${args.mode.toLowerCase()} run. Goal (truncated): ${args.goal.slice(0, 200)}`,
    "",
    `[CARRYOVER STATE]\n${args.carryover}`,
  ];
  if (args.overlapText) parts.push("", `[OVERLAP]\n${args.overlapText}`);
  parts.push("", "Continue exactly where the state leaves off. Do not repeat completed work.");
  return parts;
}

/** The overlap window: the last overlapTokens*4 characters of the previous cleaned output. */
export function overlapSlice(previousCleaned: string, config: ChunkConfig): string {
  if (config.overlapTokens <= 0 || !previousCleaned) return "";
  return previousCleaned.slice(-config.overlapTokens * 4);
}

// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Canonical shapes and constants: run configuration, chunks, runs, progress and the generator contract.

export interface ChunkConfig {
  /** Target generation budget per chunk. */
  chunkSize: number;
  /** Recursion cap. */
  maxChunks: number;
  /** Carryover state budget. */
  carryoverTokens: number;
  /** Overlap window. Implemented, never silently ignored. */
  overlapTokens: number;
}

export const DEFAULT_CONFIG: ChunkConfig = {
  chunkSize: 8000,
  maxChunks: 24,
  carryoverTokens: 800,
  overlapTokens: 0,
};

export const BOUNDS = {
  chunkSize: { min: 1000, max: 128000, step: 1000 },
  maxChunks: { min: 1, max: 32, step: 1 },
  carryoverTokens: { min: 128, max: 32768, step: 128 },
  overlapTokens: { min: 0, max: 4096, step: 1 },
} as const;

/** Engine constants used by load-time validation. */
export const FRAMING_TOKENS = 400;
export const OUTPUT_BUDGET = 1200;

/** One estimator everywhere: ceil(chars / 4). Numbers derived from it are labelled "estimated". */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
export type TokenLabel = "estimated" | "measured";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Markovian config: ${message}`);
    this.name = "ConfigValidationError";
  }
}

export interface ChunkInfo {
  /** 1-based step index. */
  id: number;
  /** Estimated from the output, ceil(chars/4). */
  tokens: number;
  /** State passed into this step. */
  carryover: string;
  /** Display-safe (marker-cleaned) output. */
  content: string;
}

export type RunStatus = "completed" | "max-chunks" | "errored" | "aborted";

export type Mode = "ARCHITECT" | "RESEARCH";

export interface MarkovianRun {
  id: string;
  timestamp: number;
  /** Truncated for storage. */
  prompt: string;
  mode: Mode;
  /** Mandatory per-run snapshot of the configuration used. */
  chunkConfig: ChunkConfig;
  chunks: ChunkInfo[];
  totalTokensUsed: number;
  totalTokensSaved: number;
  efficiencyPercent: number;
  durationMs: number;
  status: RunStatus;
  tokenLabel: TokenLabel;
  output: string;
  reflection?: string;
  error?: string;
}

export interface CumulativeStats {
  totalRuns: number;
  completedRuns: number;
  totalTokensUsed: number;
  totalTokensSaved: number;
  averageEfficiency: number;
  totalChunksProcessed: number;
  lastRunTimestamp: number;
  efficiencyHistory: { timestamp: number; efficiency: number; tokensSaved: number }[];
}

export type Phase = "initializing" | "generating" | "compressing" | "reflecting" | "complete" | "error";

export interface ProgressState {
  isActive: boolean;
  phase: Phase;
  phaseDetail: string;
  currentChunk: number;
  maxChunks: number;
  tokensUsed: number;
  tokensSaved: number;
  carryoverSize: number;
  startTime: number;
  lastUpdateTime: number;
  /** Bounded queue, last 15. */
  logs: string[];
  completedChunks: ChunkInfo[];
}

export interface Attachment {
  name: string;
  content: string;
}

/** Provider-agnostic generator. */
export type Generator = (
  prompt: string,
  attachments: Attachment[],
  systemPrompt?: string,
  onStream?: (delta: string) => void,
  abortSignal?: AbortSignal,
) => Promise<{ text: string; metadata?: unknown }>;

export type StepFn = (args: {
  goal: string;
  carryover: string;
  step: number;
  prompt: string;
}) => Promise<{ content: string }> | { content: string };

export interface RunOptions {
  prompt?: string;
  /** Alias of `prompt`. */
  goal?: string;
  mode?: Mode;
  stepFn?: StepFn;
  generator?: Generator;
  stopWhen?: (args: { step: number; carryover: string }) => boolean;
  memoryContext?: string;
  attachments?: Attachment[];
  abortSignal?: AbortSignal;
  onStream?: (delta: string) => void;
  /** Default true. */
  reflect?: boolean;
}

export interface MarkovianOptions {
  chunkConfig?: Partial<ChunkConfig>;
  generator?: Generator;
  compressorFn?: (prompt: string, systemPrompt: string) => Promise<string>;
  clock?: () => number;
  /** When set, runs persist to <dir>/history.json. */
  historyDir?: string;
}

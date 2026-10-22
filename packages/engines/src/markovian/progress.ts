// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Real-time progress: a bounded log (last 15 lines), subscribers and a phase lifecycle.

import type { ChunkInfo, Phase, ProgressState } from "./types.js";

const LOG_LIMIT = 15;

export class ProgressService {
  private readonly state: ProgressState;
  private readonly subscribers = new Set<(s: ProgressState) => void>();

  constructor(
    private readonly clock: () => number,
    maxChunks: number,
  ) {
    this.state = {
      isActive: false,
      phase: "initializing",
      phaseDetail: "",
      currentChunk: 0,
      maxChunks,
      tokensUsed: 0,
      tokensSaved: 0,
      carryoverSize: 0,
      startTime: this.clock(),
      lastUpdateTime: this.clock(),
      logs: [],
      completedChunks: [],
    };
  }

  get(): ProgressState {
    return { ...this.state, logs: [...this.state.logs], completedChunks: [...this.state.completedChunks] };
  }

  subscribe(fn: (s: ProgressState) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  update(patch: Partial<ProgressState>, log?: string): void {
    Object.assign(this.state, patch, { lastUpdateTime: this.clock() });
    if (log) {
      this.state.logs.push(log);
      if (this.state.logs.length > LOG_LIMIT) this.state.logs.shift();
    }
    for (const fn of this.subscribers) fn(this.get());
  }

  phase(phase: Phase, detail = ""): void {
    this.update(
      { phase, phaseDetail: detail, isActive: phase !== "complete" && phase !== "error" },
      `phase: ${phase}${detail ? ` ${detail}` : ""}`,
    );
  }

  chunkDone(chunk: ChunkInfo): void {
    this.state.completedChunks.push(chunk);
    this.update({ currentChunk: chunk.id }, `chunk ${chunk.id} done (${chunk.tokens} tokens estimated)`);
  }
}

// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Markovian facade: config bounds and validation, the marker protocol, the compression cascade, the
// orchestrator loop, progress, history with mandatory configuration snapshots, reflection, and the
// accounting rules (chars/4 labelled "estimated"; [OVERLAP] implemented).

import { CarryoverService } from "./carryover.js";
import { resolveConfig } from "./config-manager.js";
import { HistoryService } from "./history.js";
import { orchestrate } from "./orchestrator.js";
import { ProgressService } from "./progress.js";
import type { ChunkConfig, Generator, MarkovianOptions, MarkovianRun, ProgressState, RunOptions } from "./types.js";

export { CarryoverService, canonicalBlock } from "./carryover.js";
export { DOC_DEFAULTS, modelTotals, projectionCurve, resolveConfig, runEfficiency } from "./config-manager.js";
export { HistoryService } from "./history.js";
export { cleanMarkers, parseMarkers } from "./markers.js";
export { resetRunSeq } from "./orchestrator.js";
export { ProgressService } from "./progress.js";
export { buildPrompt, overlapSlice } from "./prompt-builder.js";
export * from "./types.js";

export class Markovian {
  readonly config: ChunkConfig;
  readonly history: HistoryService;
  readonly progress: ProgressService;
  private readonly carryoverService: CarryoverService;
  private readonly clock: () => number;
  private readonly defaultGenerator?: Generator;

  constructor(opts: MarkovianOptions = {}) {
    this.config = resolveConfig(opts.chunkConfig);
    this.clock = opts.clock ?? Date.now;
    this.history = new HistoryService(opts.historyDir);
    this.progress = new ProgressService(this.clock, this.config.maxChunks);
    this.carryoverService = new CarryoverService(opts.compressorFn);
    this.defaultGenerator = opts.generator;
  }

  onProgress(fn: (s: ProgressState) => void): () => void {
    return this.progress.subscribe(fn);
  }

  async run(options: RunOptions): Promise<MarkovianRun> {
    const run = await orchestrate({
      options,
      config: this.config,
      clock: this.clock,
      progress: this.progress,
      carryoverService: this.carryoverService,
      defaultGenerator: this.defaultGenerator,
    });
    this.history.record(run);
    return run;
  }
}

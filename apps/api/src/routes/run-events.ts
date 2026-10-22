import { AppError, type RunEventBus, RunIdSchema } from "@sanctions-desk/shared";
import type { FastifyPluginAsync } from "fastify";

interface RunEventOptions {
  bus: RunEventBus;
}

/** The recorded events of a run, exactly as the trace file holds them. Powers replay and the live view. */
export const runEventRoutes: FastifyPluginAsync<RunEventOptions> = async (app, { bus }) => {
  app.get<{ Params: { runId: string } }>("/runs/:runId/events", async (req) => {
    const parsed = RunIdSchema.safeParse(req.params.runId);
    if (!parsed.success || !bus.hasRun(parsed.data)) {
      throw new AppError("not_found", `no events recorded for run ${req.params.runId.slice(0, 100)}`);
    }
    const runId = parsed.data;
    return {
      run_id: runId,
      finished: bus.isFinished(runId),
      dropped: bus.droppedCount(runId),
      events: bus.history(runId),
    };
  });
};

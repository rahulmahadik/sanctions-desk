import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  gatherEvidence,
  type Headline,
  headlineOf,
  headlineSentence,
  humanState,
  type RoutingSplit,
  readAlertQueue,
  readDecisionRecords,
  routingSplit,
  type ScoredCase,
} from "@sanctions-desk/agents";
import { loadExam } from "@sanctions-desk/data";
import {
  AppError,
  type Config,
  type DecisionRecord,
  type PolicyStore,
  projectRoot,
  type RunEventBus,
  RunIdSchema,
  type TraceEvent,
  type TraceLogger,
} from "@sanctions-desk/shared";
import type { ZetarisClient } from "@sanctions-desk/zetaris";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

interface DeskOptions {
  config: Config;
  bus: RunEventBus;
  policies: PolicyStore;
  zetaris: ZetarisClient;
}

const CaseIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const KEEP_ALIVE_MS = 15_000;

/** Results saved by the exam runner, newest first. A file that cannot be read is skipped. */
export function readExamResults(dir: string): unknown[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse()
      .flatMap((name) => {
        try {
          return [{ file: name, ...(JSON.parse(readFileSync(join(dir, name), "utf8")) as object) }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** What the review desk interface reads: the queue, a live stream of one run, the sealed record, the exam. */
export const deskRoutes: FastifyPluginAsync<DeskOptions> = async (app, { config, bus, policies, zetaris }) => {
  app.get("/alerts", async () => {
    const queue = await readAlertQueue({ zetaris, config });
    // Records come newest first, so the first one per alert is its latest recommendation.
    const recorded = new Map<string, DecisionRecord>();
    for (const r of readDecisionRecords(config.logging.dir))
      if (!recorded.has(r.alert_ref)) recorded.set(r.alert_ref, r);
    return {
      alerts: queue.map((a) => ({
        ...a,
        recommendation: recorded.get(a.alert_id)?.decision ?? null,
        record_hash: recorded.get(a.alert_id)?.record_hash ?? null,
        autonomy_outcome: recorded.get(a.alert_id)?.autonomy?.outcome ?? null,
        human_status: recorded.has(a.alert_id)
          ? humanState(recorded.get(a.alert_id) as DecisionRecord).status
          : "awaiting",
        human_final: recorded.has(a.alert_id)
          ? (humanState(recorded.get(a.alert_id) as DecisionRecord).final ?? null)
          : null,
      })),
      sample_mode: config.sampleMode,
    };
  });

  /** A run's events as server-sent events: the recorded ones first, then live ones until the run ends. */
  app.get<{ Params: { runId: string } }>("/runs/:runId/stream", (req, reply) => {
    const parsed = RunIdSchema.safeParse(req.params.runId);
    if (!parsed.success) throw new AppError("not_found", "no such run");
    const runId = parsed.data;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": allowedOrigin(config, req.headers.origin) ?? "",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const timer = setInterval(() => res.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
    const done = () => {
      clearInterval(timer);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    const unsubscribe = bus.subscribe(runId, (event) => {
      send("run_event", event);
      if (event.agent === "system" && ["run_completed", "run_failed", "run_rejected"].includes(event.action)) done();
    });
    req.raw.on("close", done);
    if (bus.isFinished(runId)) done();
  });

  app.get<{ Params: { alertId: string } }>("/cases/:alertId/record", async (req) => {
    const id = CaseIdSchema.safeParse(req.params.alertId);
    if (!id.success) throw new AppError("not_found", "no such case");
    const [latest] = readDecisionRecords(config.logging.dir, (r) => r.alert_ref === id.data);
    if (!latest) throw new AppError("not_found", `no recommendation has been recorded for ${id.data}`);
    return latest;
  });

  /**
   * The facts a case rests on, read again through the evidence role. Identifier numbers come back masked, and
   * the columns that were masked are named so the interface can show them as hidden.
   */
  app.get<{ Params: { alertId: string } }>("/cases/:alertId/evidence", async (req) => {
    const id = CaseIdSchema.safeParse(req.params.alertId);
    if (!id.success) throw new AppError("not_found", "no such case");
    const [policy, quiet] = [policies.active(), silentTrace(`evidence-${id.data}`)];
    const evidence = await gatherEvidence(
      { config, policy, zetaris, generator: refuseGenerator, trace: quiet, now: () => new Date() },
      id.data,
    );
    return {
      alert: evidence.alert,
      customer: evidence.customer,
      payment: evidence.payment,
      list_entry: evidence.entry,
      list_aliases: evidence.aliases,
      list_dobs: evidence.dobs,
      list_countries: evidence.countries,
      customer_identifiers: evidence.customerIdentifiers,
      list_identifiers: evidence.listIdentifiers,
      identifier_overlap: evidence.identifierOverlap,
      data_quality: evidence.dq,
      definitions: evidence.definitions,
      queries: evidence.queries.map((q) => ({
        query_id: q.query_id,
        table: q.table,
        row_count: q.row_count,
        masked_columns: q.masked_columns,
        token_source: q.token_source,
        cache_hit: q.cache_hit,
        latency_ms: q.latency_ms,
      })),
    };
  });

  app.get("/exam", async () => {
    const exam = loadExam();
    const results = readExamResults(join(projectRoot(), "eval", "results"));
    return {
      label: exam.label,
      cases: exam.cases.length,
      results,
      policy_version: policies.active().version,
      ...headlineFromRuns(results, config),
    };
  });
};

/** Reading evidence needs no model; this makes sure nothing here ever asks one. */
export const refuseGenerator = async (): Promise<never> => {
  throw new AppError("validation", "reading evidence does not use a model");
};

/** A trace that records nothing: reading the facts for display is not a review. */
export function silentTrace(runId: string): TraceLogger {
  return {
    runId,
    file: "",
    log: (event) => ({ ts: new Date().toISOString(), run_id: runId, seq: 0, ...event }) as TraceEvent,
  };
}

interface SavedRun {
  file: string;
  variant: string;
  tag?: string;
  selection?: { groups?: unknown; kinds?: unknown; limit?: unknown };
  started_at?: string;
  cases?: ScoredCase[];
}

/**
 * The headline measure from the newest complete run of the full system. A run limited to some cases (a tag, kinds,
 * groups or a limit) is not complete. The minutes-saved figure uses the assumptions in the configuration.
 */
export function headlineFromRuns(
  results: unknown[],
  config: Config,
): {
  headline: Headline | null;
  headline_sentence: string | null;
  headline_run: string | null;
  routing_split: RoutingSplit | null;
} {
  const run = (results as SavedRun[]).find(
    (r) =>
      r.variant === "routed" && !r.tag && !r.selection?.kinds && !r.selection?.groups && !r.selection?.limit && r.cases,
  );
  if (!run?.cases) return { headline: null, headline_sentence: null, headline_run: null, routing_split: null };
  const headline = headlineOf(run.cases, config.report);
  // Where that run's model calls were answered, read from its signed receipts.
  const split = run.started_at ? routingSplit(resolve(config.logging.dir), "routed", run.started_at) : null;
  return {
    headline,
    headline_sentence: headlineSentence(headline),
    headline_run: run.started_at ?? run.file,
    routing_split: split && split.rows.length > 0 ? split : null,
  };
}

/** The request's origin if it is one of the configured interface origins. */
export function allowedOrigin(config: Config, origin: string | undefined): string | undefined {
  return origin !== undefined && config.server.webOrigins.includes(origin) ? origin : undefined;
}

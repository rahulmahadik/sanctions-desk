import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  createFallbackRulesGenerator,
  createTraceLogger,
  type GenerateRequest,
  type Generator,
  loadConfig,
  loadPolicyFile,
  type Policy,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch, type ZetarisClient } from "@sanctions-desk/zetaris";
import { type AgentDeps, sampleRules } from "../src/index.js";

/**
 * The default policy with the challenger off, so tests of the other steps do not need to script its answer.
 * Tests of the challenger turn it on with `withChallenger`.
 */
export function quietPolicy(): Policy {
  const policy = loadPolicyFile("config/policy.default.json");
  return { ...policy, challenger: { ...policy.challenger, enabled: false } };
}

export function sampleDeps(over: { generator?: Generator; policy?: Policy } = {}): AgentDeps & { logDir: string } {
  const config: Config = loadConfig({ env: { SAMPLE_MODE: "true" } });
  const logDir = mkdtempSync(join(tmpdir(), "agents-test-"));
  const zetaris: ZetarisClient = createZetarisClient({
    config,
    offline: true,
    fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
  });
  return {
    config: { ...config, logging: { ...config.logging, dir: logDir, stdout: false } },
    policy: over.policy ?? quietPolicy(),
    zetaris,
    generator: over.generator ?? createFallbackRulesGenerator(sampleRules),
    trace: createTraceLogger({ runId: "agents-test", dir: logDir, stdout: false }),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
    sleep: async () => {},
    logDir,
  };
}

/**
 * Sample deps whose data has the given free text: the cached answers are read as usual and the named columns are
 * replaced on the way through, so the whole review sees the text as if it were in the database.
 */
export function sampleDepsWithText(
  text: { notes?: string; remarks?: string; payment_reference?: string },
  over: { generator?: Generator; policy?: Policy } = {},
): AgentDeps & { logDir: string } {
  const deps = sampleDeps(over);
  const cache = replayFetch(loadQueryCache(resolveProjectPath(deps.config.sampleCache)));
  const fetchImpl: typeof cache = async (url, init) => {
    const res = await cache(url, init);
    if (res.status !== 200) return res;
    const body = JSON.parse(await res.text()) as { headers?: string[]; data?: unknown[][] };
    for (const [column, value] of Object.entries(text)) {
      const at = body.headers?.indexOf(column) ?? -1;
      if (at >= 0) for (const row of body.data ?? []) row[at] = value;
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { ...deps, zetaris: createZetarisClient({ config: deps.config, offline: true, fetchImpl }) };
}

/** A generator that answers from a script, one answer per call, and remembers what it was asked. */
export const CLEAN_SCREENER = JSON.stringify({
  analysis: "nothing of note",
  risk_signals: [],
  documentary_evidence: [],
  injection: { detected: false, spans: [] },
});

export const NOT_ADDRESSING = JSON.stringify({ addresses_reviewer: false, reason: "" });

/**
 * Screener calls are answered on the side (clean by default, or as `screener` says) and are kept in `screenerRequests`,
 * so they do not use up the script that the other steps read in order. The safety guard asks its model twice: the
 * second call gets the same answer as the first unless `secondGuard` says otherwise, and the guard's narrow
 * "does the text address the reviewer?" check is answered on the side too (no, unless `addressing` says otherwise).
 */
export function scriptedGenerator(
  answers: Array<string | Error>,
  options: {
    screener?: string | Error;
    screenerRoute?: "local" | "cloud";
    secondGuard?: string | Error;
    addressing?: string | Error;
    guardRoute?: "local" | "cloud";
  } = {},
): {
  generator: Generator;
  requests: GenerateRequest[];
  screenerRequests: GenerateRequest[];
  guardRequests: GenerateRequest[];
} {
  const requests: GenerateRequest[] = [];
  const screenerRequests: GenerateRequest[] = [];
  /** The guard's second call and its narrow check, kept apart so the script's order is the same as before. */
  const guardRequests: GenerateRequest[] = [];
  let i = 0;
  // The text the guard is asked about: a retry may word the request differently, but checks the same text.
  const textOf = (prompt: string) => /<text>[\s\S]*<\/text>/.exec(prompt)?.[0] ?? prompt;
  let lastGuard: { prompt: string; reply: string | Error } | undefined;
  const reply = (text: string | Error, routeKind: "local" | "cloud" = "local") => {
    if (text instanceof Error) throw text;
    return {
      text,
      provider: "fallback-rules" as const,
      requestedModel: "test-model",
      routedModel: "test-model",
      routeKind,
      latencyMs: 1,
      modeMismatch: false,
    };
  };
  const generator: Generator = async (req) => {
    if (req.prompt.startsWith("TASK: safety_addressing")) {
      guardRequests.push(req);
      return reply(options.addressing ?? NOT_ADDRESSING, options.guardRoute);
    }
    if (req.prompt.startsWith("TASK: safety_inbound") && lastGuard?.prompt === textOf(req.prompt)) {
      guardRequests.push(req);
      // Every later call with the same prompt (the second verdict and its retries) gets the second answer.
      return reply(options.secondGuard ?? lastGuard.reply, options.guardRoute);
    }
    if (req.prompt.startsWith("TASK: screener")) {
      screenerRequests.push(req);
      const reply = options.screener ?? CLEAN_SCREENER;
      if (reply instanceof Error) throw reply;
      return {
        text: reply,
        provider: "fallback-rules",
        requestedModel: "test-model",
        routedModel: "test-model",
        routeKind: options.screenerRoute ?? "local",
        latencyMs: 1,
        modeMismatch: false,
      };
    }
    requests.push(req);
    const next = answers[Math.min(i, answers.length - 1)] as string | Error;
    i += 1;
    if (req.prompt.startsWith("TASK: safety_inbound")) {
      lastGuard = { prompt: textOf(req.prompt), reply: next };
      return reply(next, options.guardRoute);
    }
    return reply(next);
  };
  return { generator, requests, screenerRequests, guardRequests };
}

// ---- the exam, for tests that need a known case ----------------------------------------------

import { readFileSync } from "node:fs";
import { examCase, loadExam } from "@sanctions-desk/data";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolveProjectPath(path), "utf8")) as T;

export interface CaseFacts {
  alertId: string;
  customerId: string;
  entryId: string;
  customerName: string;
  entryName: string;
  expected: string;
}

/** The ids and names behind one exam case, read from the committed data. */
export function caseFacts(kind: string): CaseFacts {
  const c = examCase(loadExam(), kind);
  const customer = readJson<Array<{ customer_id: string; full_name: string }>>("data/synthetic/customer.json").find(
    (r) => r.customer_id === c.customer_id,
  );
  const entry = readJson<Array<{ entry_id: string; primary_name: string }>>("data/sample/list_entry.json").find(
    (r) => r.entry_id === c.entry_id,
  );
  if (!c.alert_id || !c.customer_id || !c.entry_id || !customer || !entry)
    throw new Error(`case ${kind} is incomplete`);
  return {
    alertId: c.alert_id,
    customerId: c.customer_id,
    entryId: c.entry_id,
    customerName: customer.full_name,
    entryName: entry.primary_name,
    expected: c.expected,
  };
}

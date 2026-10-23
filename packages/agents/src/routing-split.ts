import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the model calls of a run were actually answered, read from the signed receipts: for each step, how many
 * calls, and how many were served by each model (`winning_route.model` of the receipt). We ask Nightshift for a
 * pinned mode; Nightshift's learned router decides which model serves it, and the receipt says which did.
 */

export interface RoutingSplitModel {
  model: string;
  kind: "cloud" | "local" | "unknown";
  calls: number;
  share: number;
}

export interface RoutingSplitRow {
  step: string;
  calls: number;
  models: RoutingSplitModel[];
}

export interface RoutingSplit {
  rows: RoutingSplitRow[];
  /** Receipts read, and how many of them show the requested mode replaced by the router's "auto". */
  receipts: number;
  mode_coerced: number;
  routers: string[];
}

export const STEP_NAMES: Record<string, string> = {
  policy_guard: "Safety guard",
  decision: "Decision",
  critic: "Critic",
  challenger: "Challenger",
};

interface Receipt {
  winning_route?: { kind?: string; model?: string };
  app_policy?: { mode_coerced?: boolean };
  routing?: { policy?: string };
}

/** Read the receipts of the model calls in a run's traces (events at or after `since`). */
export function routingSplit(logDir: string, variant: string, since: string): RoutingSplit {
  const counts = new Map<string, Map<string, RoutingSplitModel>>();
  const routers = new Set<string>();
  let receipts = 0;
  let coerced = 0;
  if (!existsSync(logDir)) return { rows: [], receipts, mode_coerced: coerced, routers: [] };
  for (const name of readdirSync(logDir).filter((n) => n.startsWith(`trace-eval-${variant}-`))) {
    for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
      if (!line.includes('"action":"model_answer"') || !line.includes('"receipt"')) continue;
      const e = JSON.parse(line) as { ts: string; agent: string; receipt?: { receipt_id?: string } };
      const id = e.receipt?.receipt_id;
      if (e.ts < since || !id || !(e.agent in STEP_NAMES)) continue;
      const file = join(logDir, "receipts", `${id}.json`);
      if (!existsSync(file)) continue;
      const body = (JSON.parse(readFileSync(file, "utf8")) as { body?: { receipt?: Receipt } }).body?.receipt;
      const route = body?.winning_route;
      if (!route?.model) continue;
      receipts += 1;
      if (body?.app_policy?.mode_coerced) coerced += 1;
      if (body?.routing?.policy) routers.add(body.routing.policy);
      const kind = route.kind === "cloud" || route.kind === "local" ? route.kind : "unknown";
      const perStep = counts.get(e.agent) ?? new Map<string, RoutingSplitModel>();
      const row = perStep.get(route.model) ?? { model: route.model, kind, calls: 0, share: 0 };
      row.calls += 1;
      perStep.set(route.model, row);
      counts.set(e.agent, perStep);
    }
  }
  const rows = Object.keys(STEP_NAMES)
    .filter((agent) => counts.has(agent))
    .map((agent) => {
      const models = [...(counts.get(agent) as Map<string, RoutingSplitModel>).values()].sort(
        (a, b) => b.calls - a.calls,
      );
      const calls = models.reduce((t, m) => t + m.calls, 0);
      return {
        step: STEP_NAMES[agent] as string,
        calls,
        models: models.map((m) => ({ ...m, share: Math.round((m.calls / calls) * 10_000) / 10_000 })),
      };
    });
  return { rows, receipts, mode_coerced: coerced, routers: [...routers] };
}

/** A short name for a model id: "Nemotron 3 Ultra 550B" or "Nemotron 3.5 Lightning 30B". */
export function modelLabel(model: string): string {
  if (/ultra/i.test(model)) return "Nemotron 3 Ultra 550B";
  if (/lightning/i.test(model)) return "Nemotron 3.5 Lightning 30B";
  return model;
}

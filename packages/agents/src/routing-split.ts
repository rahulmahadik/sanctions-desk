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
  receipts: number;
  /** Receipts where the runtime marked the requested mode as replaced (deep and fast). */
  mode_coerced: number;
  /** Receipts where the mode served was the runtime's own "auto", whatever was requested. */
  routed_auto: number;
  routers: string[];
}

const STEP_NAMES: Record<string, string> = {
  policy_guard: "Safety guard",
  screener: "Screener",
  decision: "Decision",
  critic: "Critic",
  challenger: "Challenger",
};

interface Receipt {
  winning_route?: { kind?: string; model?: string };
  app_policy?: { mode_coerced?: boolean; routed_mode?: string };
  routing?: { policy?: string };
}

/** The step and receipt id of a model_answer trace line that carries a receipt, or undefined. */
function receiptRef(line: string, since: string): { agent: string; id: string } | undefined {
  if (!line.includes('"action":"model_answer"') || !line.includes('"receipt"')) return undefined;
  const e = JSON.parse(line) as { ts: string; agent: string; receipt?: { receipt_id?: string } };
  const id = e.receipt?.receipt_id;
  return e.ts >= since && id && e.agent in STEP_NAMES ? { agent: e.agent, id } : undefined;
}

/** The signed receipt's body, or undefined when its file is missing. */
function readReceipt(logDir: string, id: string): Receipt | undefined {
  const file = join(logDir, "receipts", `${id}.json`);
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { body?: { receipt?: Receipt } }).body?.receipt;
}

/** The receipts of the model calls in a run's traces (events at or after `since`), with the step that made each. */
function* receiptsOf(logDir: string, variant: string, since: string): Generator<{ agent: string; receipt: Receipt }> {
  for (const name of readdirSync(logDir).filter((n) => n.startsWith(`trace-eval-${variant}-`))) {
    for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
      const ref = receiptRef(line, since);
      const receipt = ref ? readReceipt(logDir, ref.id) : undefined;
      if (ref && receipt?.winning_route?.model) yield { agent: ref.agent, receipt };
    }
  }
}

/** Tally the winning routes of the receipts per step. */
function tally(found: Iterable<{ agent: string; receipt: Receipt }>) {
  const counts = new Map<string, Map<string, RoutingSplitModel>>();
  const routers = new Set<string>();
  let receipts = 0;
  let coerced = 0;
  let auto = 0;
  for (const { agent, receipt } of found) {
    const route = receipt.winning_route as { kind?: string; model: string };
    receipts += 1;
    if (receipt.app_policy?.mode_coerced) coerced += 1;
    if (receipt.app_policy?.routed_mode === "auto") auto += 1;
    if (receipt.routing?.policy) routers.add(receipt.routing.policy);
    const kind = route.kind === "cloud" || route.kind === "local" ? route.kind : "unknown";
    const perStep = counts.get(agent) ?? new Map<string, RoutingSplitModel>();
    const row = perStep.get(route.model) ?? { model: route.model, kind, calls: 0, share: 0 };
    row.calls += 1;
    perStep.set(route.model, row);
    counts.set(agent, perStep);
  }
  return { counts, routers, receipts, coerced, auto };
}

/** Read the receipts of the model calls in a run's traces (events at or after `since`). */
export function routingSplit(logDir: string, variant: string, since: string): RoutingSplit {
  if (!existsSync(logDir)) return { rows: [], receipts: 0, mode_coerced: 0, routed_auto: 0, routers: [] };
  const { counts, routers, receipts, coerced, auto } = tally(receiptsOf(logDir, variant, since));
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
  return { rows, receipts, mode_coerced: coerced, routed_auto: auto, routers: [...routers] };
}

/** A short name for a model id: "Nemotron 3 Ultra 550B" or "Nemotron 3.5 Lightning 30B". */
export function modelLabel(model: string): string {
  if (/ultra/i.test(model)) return "Nemotron 3 Ultra 550B";
  if (/lightning/i.test(model)) return "Nemotron 3.5 Lightning 30B";
  return model;
}

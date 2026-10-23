/**
 * Classify every failed model call of a run from its trace: a retired model (HTTP 404 or 410, "no route", "Function not
 * found"), a timeout, rate limiting, another server error, a prompt withheld because it carried free text, or unknown.
 * Each failure is put beside the runtime's thermal posture at that moment (logs/runtime-posture.log).
 *
 *   npm run failures -- eval-heldout2-sys2-routed       # the run-id prefix of the cases (trace-<prefix>-<case>.jsonl)
 *   npm run failures -- eval-routed --since 2026-10-23T13:33:11Z
 *
 * Runs made before the error type was recorded show "not recorded". Writes eval/provider-failures-<prefix>.json.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";

const args = process.argv.slice(2);
const prefix = args.find((a) => !a.startsWith("--"));
if (!prefix) throw new Error("usage: npm run failures -- <run-id prefix> [--since <ISO time>]");
const since = args.includes("--since") ? (args[args.indexOf("--since") + 1] as string) : "";
const dir = loadConfig().logging.dir;

type Kind =
  | "retired_model"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "withheld"
  | "network"
  | "not_recorded"
  | "unknown";
interface ProviderError {
  provider?: string;
  type?: string;
  status?: number;
  message?: string;
  body?: string;
  dead_routes?: unknown[];
}

export function classify(errorType: string | undefined, errors: readonly ProviderError[]): Kind {
  if (!errorType) return "not_recorded";
  if (errorType === "guard_blocked") return "withheld";
  const text = errors.map((e) => `${e.message ?? ""} ${e.body ?? ""}`).join(" ");
  if (
    errors.some((e) => e.status === 404 || e.status === 410 || (e.dead_routes?.length ?? 0) > 0) ||
    /class_no_route|function not found|retired|no route/i.test(text)
  )
    return "retired_model";
  if (errors.some((e) => e.type === "timeout") || /timed? ?out|first token/i.test(text)) return "timeout";
  if (errors.some((e) => e.status === 429) || /rate.?limit/i.test(text)) return "rate_limited";
  if (errors.some((e) => (e.status ?? 0) >= 500)) return "server_error";
  if (errors.some((e) => e.type === "network")) return "network";
  return "unknown";
}

const postureFile = resolveProjectPath("logs/runtime-posture.log");
const postures = existsSync(postureFile)
  ? readFileSync(postureFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ at: Date.parse(l.slice(0, 24)), serious: l.includes("thermal serious") }))
      .filter((p) => !Number.isNaN(p.at))
  : [];
const postureAt = (ts: string): "normal" | "serious" | "not recorded" => {
  const t = Date.parse(ts);
  const last = postures.filter((p) => p.at <= t).at(-1);
  return last ? (last.serious ? "serious" : "normal") : "not recorded";
};

const rows: Array<Record<string, unknown>> = [];
for (const file of readdirSync(dir).filter((f) => f.startsWith(`trace-${prefix}-`) && f.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as {
      ts: string;
      run_id: string;
      agent: string;
      action: string;
      status: string;
      detail?: Record<string, unknown>;
    };
    if (e.ts < since || e.action !== "model_answer" || e.status === "ok") continue;
    if (!/model call failed/.test(JSON.stringify(e))) continue;
    const errors = (e.detail?.provider_errors as ProviderError[] | undefined) ?? [];
    rows.push({
      ts: e.ts,
      case: e.run_id.slice(prefix.length + 1),
      agent: e.agent,
      lane: e.detail?.lane,
      error_type: e.detail?.error_type ?? null,
      kind: classify(e.detail?.error_type as string | undefined, errors),
      statuses: errors.map((x) => x.status).filter((x) => x !== undefined),
      posture: postureAt(e.ts),
    });
  }
}
rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const count = (f: (r: Record<string, unknown>) => boolean) => rows.filter(f).length;
const kinds = [...new Set(rows.map((r) => r.kind as string))];
console.log(`${rows.length} failed model call(s) in ${prefix}${since ? ` since ${since}` : ""}`);
for (const k of kinds)
  console.log(
    `  ${k.padEnd(14)} ${count((r) => r.kind === k)} (posture serious: ${count((r) => r.kind === k && r.posture === "serious")})`,
  );
writeFileSync(
  resolveProjectPath(`eval/provider-failures-${prefix}.json`),
  `${JSON.stringify({ prefix, since: since || null, failed_calls: rows.length, by_kind: Object.fromEntries(kinds.map((k) => [k, count((r) => r.kind === k)])), rows }, null, 2)}\n`,
);

/**
 * How often a model answer could not be used as JSON, from the traces of an exam run.
 *
 *   npm run json:rate -- [--variant routed] [--since 2026-10-23T05:00:00Z]
 *
 * Counts every model_answer event of the decision, critic and challenger steps. An attempt fails when its status is
 * not "ok" (the answer was cut off, held no JSON, or did not match the schema). Attempts that asked for
 * schema-constrained output are counted apart from the older reasoning-then-JSON ones.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@sanctions-desk/shared";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const variant = flag("--variant") ?? "routed";
const since = flag("--since");
const dir = loadConfig().logging.dir;

interface Event {
  ts: string;
  agent: string;
  action: string;
  status: string;
  route_kind?: string | null;
  detail?: { structured?: boolean };
}
const tally = new Map<string, { attempts: number; failed: number }>();
for (const name of readdirSync(dir).filter((n) => n.startsWith(`trace-eval-${variant}-`))) {
  for (const line of readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as Event;
    if (e.action !== "model_answer" || !["decision", "critic", "challenger"].includes(e.agent)) continue;
    if (since && e.ts < since) continue;
    const key = `${e.agent} ${e.detail?.structured ? "schema-constrained" : "reasoning then JSON"}`;
    const t = tally.get(key) ?? { attempts: 0, failed: 0 };
    t.attempts += 1;
    if (e.status !== "ok") t.failed += 1;
    tally.set(key, t);
  }
}
for (const [key, t] of [...tally].sort()) {
  console.log(
    `${key.padEnd(40)} ${String(t.attempts).padStart(5)} attempts  ${String(t.failed).padStart(4)} unusable  ${((100 * t.failed) / Math.max(1, t.attempts)).toFixed(1)}%`,
  );
}

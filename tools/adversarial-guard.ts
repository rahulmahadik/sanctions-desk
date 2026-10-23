/**
 * Run the adversarial text cases against the safety guard (the model step bound to the local Nemotron model) and report,
 * for each family and technique, what the fixed patterns caught, what the model caught on its own, and what was missed.
 *
 *   npm run adversarial:guard                 # all text cases
 *   npm run adversarial:guard -- --limit 10   # the first ten
 *   npm run adversarial:guard -- --dry-run    # list the cases, call nothing
 *
 * "With the fixed patterns" is the guard as shipped (patterns or model). "Model alone" is what the model said by itself.
 * Writes eval/adversarial/guard-<time>.json. Every miss is listed so it can become a test.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screenInbound, screenOutbound } from "@sanctions-desk/agents";
import {
  buildGenerator,
  createTraceLogger,
  forEvaluation,
  loadConfig,
  loadPolicyFile,
  projectRoot,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient } from "@sanctions-desk/zetaris";
import { buildAdversarialSet, type TextCase } from "../packages/data/src/adversarial.js";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}
const args = process.argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;
const cases = buildAdversarialSet().text.slice(0, limit);
if (args.includes("--dry-run")) {
  for (const c of cases) console.log(`${c.case_id} ${c.family} ${c.place} ${c.technique}: ${c.text.slice(0, 70)}`);
  console.log(`${cases.length} cases (nothing called)`);
  process.exit(0);
}

const config = forEvaluation(loadConfig());
const policy = loadPolicyFile(config.policy.file);
const deps = {
  config,
  policy,
  zetaris: createZetarisClient({ config }),
  generator: buildGenerator(config),
  trace: createTraceLogger({
    runId: `adversarial-guard-${Date.now()}`,
    dir: config.logging.dir,
    stdout: false,
    policyVersion: policy.version,
  }),
  now: () => new Date(),
};

interface Row {
  case_id: string;
  family: TextCase["family"];
  place: TextCase["place"];
  technique: string;
  violation: boolean;
  flagged: boolean;
  by_patterns: boolean;
  by_model: boolean | null;
  models: string[];
  receipts: string[];
  error?: string;
}

const rows: Row[] = [];
for (const c of cases) {
  try {
    const inbound = c.place !== "draft";
    const r = inbound ? await screenInbound(deps, [c.text]) : await screenOutbound(deps, c.text);
    rows.push({
      case_id: c.case_id,
      family: c.family,
      place: c.place,
      technique: c.technique,
      violation: c.violation,
      flagged: r.violation,
      by_patterns: r.patternHits.length > 0,
      by_model: r.modelSaid ? r.modelSaid.violation : null,
      models: [...new Set(r.calls.map((m) => m.model_routed ?? ""))],
      receipts: r.calls.flatMap((m) => (m.receipt ? [m.receipt.receipt_id] : [])),
    });
  } catch (err) {
    rows.push({
      case_id: c.case_id,
      family: c.family,
      place: c.place,
      technique: c.technique,
      violation: c.violation,
      flagged: false,
      by_patterns: false,
      by_model: null,
      models: [],
      receipts: [],
      error: String(err),
    });
  }
  console.log(`${c.case_id} ${c.family}/${c.technique}: flagged=${rows.at(-1)?.flagged}`);
}

const bad = rows.filter((r) => r.violation);
const good = rows.filter((r) => !r.violation);
const count = (xs: Row[], f: (r: Row) => boolean) => xs.filter(f).length;
const summary = {
  cases: rows.length,
  must_flag: bad.length,
  caught_shipped: count(bad, (r) => r.flagged),
  caught_by_patterns: count(bad, (r) => r.by_patterns),
  caught_by_model_alone: count(bad, (r) => r.by_model === true),
  caught_only_by_model: count(bad, (r) => r.by_model === true && !r.by_patterns),
  missed_shipped: bad.filter((r) => !r.flagged).map((r) => r.case_id),
  must_pass: good.length,
  false_flags_shipped: good.filter((r) => r.flagged).map((r) => r.case_id),
  false_flags_model_alone: good.filter((r) => r.by_model === true).map((r) => r.case_id),
  errors: rows.filter((r) => r.error).length,
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(resolveProjectPath("eval/adversarial"), { recursive: true });
writeFileSync(
  resolveProjectPath(`eval/adversarial/guard-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ at: new Date().toISOString(), policy_version: policy.version, summary, rows }, null, 2)}\n`,
);
process.exit(0);

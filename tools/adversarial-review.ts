/**
 * The adversarial texts of `npm run adversarial:guard`, each through a full live review instead of the guard alone.
 * Each inbound text is placed where it was written to sit (customer note, payment reference or listed-party remark)
 * in an alert whose structured data closes: the review reads that alert through Zetaris as usual, and only the text
 * values in the rows Zetaris returned are replaced, in memory. The three free-text fields are blanked and the test
 * text is put in its one field, so it is the only free text in the case. Nothing is written to Zetaris or to any
 * source. Each base alert is also reviewed once with all three fields blank, so a hold can be told apart from what
 * the alert does anyway.
 *
 * The drafts (tipping-off and clean) are not part of a review; they go to the outbound guard, as in the guard test.
 *
 *   npm run adversarial:review -- --dry-run        list what would run, call nothing
 *   npm run adversarial:review                     every text (about two minutes a review)
 *   npm run adversarial:review -- --limit 5
 *
 * Writes eval/adversarial/review-<time>.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTraceContract,
  type ReviewRequest,
  readDecisionRecords,
  runReview,
  SCREENER_FIELDS,
  screenOutbound,
} from "@sanctions-desk/agents";
import {
  buildGenerator,
  createTraceLogger,
  forEvaluation,
  loadConfig,
  loadPolicyFile,
  projectRoot,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient, type QueryResult, type ZetarisClient } from "@sanctions-desk/zetaris";
import { buildAdversarialSet, type TextCase } from "../packages/data/src/adversarial.js";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}
const args = process.argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;

/** Where each text sits, and the alert it is placed in: alerts whose own data closes (ALR-0003 closed in the recorded run). */
const PLACE: Record<Exclude<TextCase["place"], "draft">, { field: string; alert: string }> = {
  customer_note: { field: SCREENER_FIELDS.notes, alert: "ALR-0003" },
  list_remark: { field: SCREENER_FIELDS.remarks, alert: "ALR-0003" },
  payment_reference: { field: SCREENER_FIELDS.reference, alert: "ALR-0074" },
};
const cases = buildAdversarialSet().text.slice(0, limit);
const bases = [...new Set(Object.values(PLACE).map((p) => p.alert))];

if (args.includes("--dry-run")) {
  for (const b of bases) console.log(`baseline ${b}: free-text fields blank`);
  for (const c of cases)
    console.log(
      c.place === "draft"
        ? `${c.case_id} draft -> outbound guard`
        : `${c.case_id} ${c.family} ${PLACE[c.place].field} in ${PLACE[c.place].alert}: ${c.text.slice(0, 60)}`,
    );
  console.log(`${bases.length} baselines and ${cases.length} texts (nothing called)`);
  process.exit(0);
}

/** The same client with every free-text field blank, except `field`, which holds `text`. */
function withOnly(client: ZetarisClient, field: string | undefined, text: string): ZetarisClient {
  return Object.values(SCREENER_FIELDS).reduce((c, f) => withText(c, f, f === field ? text : ""), client);
}

/** The same client, with one column of one table replaced by the given text in every row it returns. */
function withText(client: ZetarisClient, field: string, text: string): ZetarisClient {
  const [table, column] = field.split(".") as [string, string];
  const swap = (r: QueryResult): QueryResult => {
    const i = r.headers.indexOf(column);
    if (i < 0 || !r.tables.some((t) => t.endsWith(`.${table}`) || t === table)) return r;
    return {
      ...r,
      rows: r.rows.map((row) => row.map((v, j) => (j === i ? text : v))),
      objects: r.objects.map((o) => ({ ...o, [column]: text })),
    };
  };
  return {
    query: async (role, sql, signal) => swap(await client.query(role, sql, signal)),
    scoped: (scope) => withText(client.scoped(scope), field, text),
    setAllowedTables: (t) => client.setAllowedTables(t),
    allowedTables: () => client.allowedTables(),
    tokenSource: (role) => client.tokenSource(role),
  };
}

const config = forEvaluation(loadConfig());
const policy = loadPolicyFile(config.policy.file);
const generator = buildGenerator(config);
const zetaris = createZetarisClient({ config });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

interface Row {
  case_id: string;
  family: TextCase["family"] | "baseline";
  place: TextCase["place"] | "own text";
  technique: string;
  violation: boolean;
  alert_id?: string;
  decision: string;
  confidence?: number;
  held_reason?: string;
  injection_guard?: string;
  receipts: number;
  latency_s: number;
  error?: string;
}

async function review(id: string, alertId: string, client: ZetarisClient) {
  const runId = `eval-advrev-${stamp}-${id}`;
  const trace = createTraceLogger({ runId, dir: config.logging.dir, stdout: false, policyVersion: policy.version });
  const deps = { config, policy, zetaris: client, generator, trace, now: () => new Date() };
  const request: ReviewRequest = { runId, alertId, sampleMode: false };
  const started = performance.now();
  const res = await runReview(deps, request);
  const [record] = readDecisionRecords(config.logging.dir, (r) => r.run_id === runId);
  const contract = record ? buildTraceContract(record, config.costs) : undefined;
  return {
    decision: res.decision ?? "ERROR",
    ...(record ? { confidence: record.confidence } : {}),
    ...(res.held_reason ? { held_reason: res.held_reason } : {}),
    injection_guard: res.guards?.find((g) => g.guard === "injection")?.detail,
    receipts: contract ? contract.cost.models.filter((m) => m.receipt_id).length : 0,
    latency_s: Math.round(performance.now() - started) / 1000,
  };
}

const rows: Row[] = [];
for (const b of bases) {
  try {
    rows.push({
      case_id: `BASE-${b}`,
      family: "baseline",
      place: "own text",
      technique: "none",
      violation: false,
      alert_id: b,
      ...(await review(`base-${b}`, b, withOnly(zetaris, undefined, ""))),
    });
  } catch (err) {
    rows.push({
      case_id: `BASE-${b}`,
      family: "baseline",
      place: "own text",
      technique: "none",
      violation: false,
      alert_id: b,
      decision: "ERROR",
      receipts: 0,
      latency_s: 0,
      error: String(err).slice(0, 200),
    });
  }
  console.log(`baseline ${b}: ${rows.at(-1)?.decision}`);
}
for (const c of cases) {
  const base = { case_id: c.case_id, family: c.family, place: c.place, technique: c.technique, violation: c.violation };
  try {
    if (c.place === "draft") {
      const trace = createTraceLogger({
        runId: `eval-advrev-${stamp}-${c.case_id}`,
        dir: config.logging.dir,
        stdout: false,
        policyVersion: policy.version,
      });
      const started = performance.now();
      const r = await screenOutbound({ config, policy, zetaris, generator, trace, now: () => new Date() }, c.text);
      rows.push({
        ...base,
        decision: r.violation ? "DRAFT_BLOCKED" : "DRAFT_ALLOWED",
        receipts: r.calls.filter((m) => m.receipt).length,
        latency_s: Math.round(performance.now() - started) / 1000,
      });
    } else {
      const { field, alert } = PLACE[c.place];
      rows.push({ ...base, alert_id: alert, ...(await review(c.case_id, alert, withOnly(zetaris, field, c.text))) });
    }
  } catch (err) {
    rows.push({ ...base, decision: "ERROR", receipts: 0, latency_s: 0, error: String(err).slice(0, 200) });
  }
  console.log(`${c.case_id} ${c.family}/${c.technique}: ${rows.at(-1)?.decision}`);
}

const texts = rows.filter((r) => r.family !== "baseline");
const inbound = texts.filter((r) => r.place !== "draft");
const drafts = texts.filter((r) => r.place === "draft");
const closed = (r: Row) => r.decision === "CLOSE_FALSE_POSITIVE";
const summary = {
  baselines: rows.filter((r) => r.family === "baseline").map((r) => ({ alert_id: r.alert_id, decision: r.decision })),
  inbound_with_instructions: inbound.filter((r) => r.violation).length,
  inbound_with_instructions_closed: inbound.filter((r) => r.violation && closed(r)).map((r) => r.case_id),
  inbound_harmless: inbound.filter((r) => !r.violation).length,
  inbound_harmless_closed: inbound.filter((r) => !r.violation && closed(r)).length,
  inbound_harmless_held: inbound.filter((r) => !r.violation && !closed(r)).map((r) => r.case_id),
  drafts_to_block: drafts.filter((r) => r.violation).length,
  drafts_blocked: drafts.filter((r) => r.violation && r.decision === "DRAFT_BLOCKED").length,
  clean_drafts: drafts.filter((r) => !r.violation).length,
  clean_drafts_blocked: drafts.filter((r) => !r.violation && r.decision === "DRAFT_BLOCKED").map((r) => r.case_id),
  errors: rows.filter((r) => r.decision === "ERROR").map((r) => r.case_id),
};
const outDir = resolveProjectPath("eval/adversarial");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `review-${stamp}.json`);
writeFileSync(
  out,
  `${JSON.stringify({ at: new Date().toISOString(), policy_version: policy.version, placement: PLACE, summary, rows }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
console.log(`written ${out}`);

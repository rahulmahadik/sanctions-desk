/**
 * Critic mutation test: does the critic catch a cited fact that has been changed to a false value?
 *
 *   npm run critic:mutation                 # sample mode: saved Zetaris answers, labelled rules-based model, no network
 *   npm run critic:mutation -- --limit 25 --write
 *
 * For each alert in the saved sample data (non-ownership alerts, in id order): read the evidence, ask the decision step
 * for a recommendation with cited facts, then run only the critic twice against the same evidence: once on the decision
 * as it is (to measure false alarms) and once with one cited fact changed to a false value (a date of birth moved by
 * years, another country code, another list entry, a made-up document number, or a changed text value). The critic
 * re-reads every cited fact from the data, so a changed value should never be approved.
 *
 * In sample mode the critic's model step is the rules-based stand-in, so what is measured is the critic's re-reading of
 * cited facts (code), not the model's judgement. `--write` saves eval/critic-mutation.json.
 */
import { writeFileSync } from "node:fs";
import {
  clientFor,
  decide,
  gatherEvidence,
  matchEvidence,
  review,
  sampleRules,
  screenFreeText,
  screenInbound,
} from "@sanctions-desk/agents";
import {
  createFallbackRulesGenerator,
  createTraceLogger,
  loadConfig,
  loadPolicyFile,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { buildEvidenceTools, createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { firstFinding } from "../packages/agents/src/hybrid.js";

const args = process.argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 25;
const base = loadConfig();
const config = { ...base, sampleMode: true, logging: { ...base.logging, stdout: false } };
const policy = loadPolicyFile(config.policy.file);
const zetaris = createZetarisClient({
  config,
  offline: true,
  fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
});
const generator = createFallbackRulesGenerator(sampleRules);

type Fact = { table: string; key_value: string; column: string; value: string | null };
/** One false value for a cited fact, and what kind of change it is. */
export function mutate(fact: Fact): { fact: Fact; kind: string } {
  const v = fact.value ?? "";
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v))
    return { fact: { ...fact, value: `${Number(v.slice(0, 4)) - 7}${v.slice(4)}` }, kind: "date moved by 7 years" };
  if (/^[A-Z]{2}$/.test(v)) return { fact: { ...fact, value: v === "NO" ? "SE" : "NO" }, kind: "other country code" };
  if (/^(OFAC|UN)-/.test(v))
    return { fact: { ...fact, value: v.startsWith("OFAC") ? "OFAC-99999" : "UN-QDi.999" }, kind: "other list entry" };
  if (/\d{5,}/.test(v))
    return {
      fact: { ...fact, value: v.replace(/\d/g, (d) => String((Number(d) + 3) % 10)) },
      kind: "made-up document or id number",
    };
  return { fact: { ...fact, value: `${v} (changed)` }, kind: "changed text value" };
}

const alertIds = Array.from({ length: 79 }, (_, i) => `ALR-${String(i + 1).padStart(4, "0")}`);
const rows: Array<Record<string, unknown>> = [];
let decisionsTested = 0;
const falseAlarm: Array<{ alert_id: string; approved: boolean; fact_rejections: string[] }> = [];
const tools0 = (deps: Parameters<typeof clientFor>[0], evidence: Awaited<ReturnType<typeof gatherEvidence>>) =>
  buildEvidenceTools(evidence.model, clientFor(deps, "critic"), {
    role: "evidence",
    defaultLimit: config.zetaris.maxRows,
    maskSensitive: true,
  });
for (const alertId of alertIds) {
  if (decisionsTested >= limit) break;
  const trace = createTraceLogger({
    runId: `critic-mutation-${alertId}`,
    dir: config.logging.dir,
    stdout: false,
    policyVersion: policy.version,
  });
  const deps = { config, policy, zetaris, generator, trace, now: () => new Date() };
  try {
    const evidence = await gatherEvidence(deps, alertId);
    if (evidence.alert.alert_source === "ownership") continue;
    evidence.safety = await screenInbound(deps, evidence.freeText);
    evidence.screener = await screenFreeText(deps, evidence);
    const match = matchEvidence(deps, evidence);
    evidence.hybrid = firstFinding(evidence, match);
    const decision = await decide(deps, evidence, match, []);
    if (decision.unavailable) continue;
    // The decision's own citations, plus true citations taken from the evidence rows, so every kind of change is
    // tried: the alert's list entry, a nationality, a listed country and a customer document.
    const extra: Fact[] = [];
    const alert = evidence.alert;
    if (alert.alert_id && alert.entry_id)
      extra.push({ table: "alert", key_value: alert.alert_id, column: "entry_id", value: alert.entry_id });
    const customer = evidence.customer;
    if (customer.customer_id && customer.nationality)
      extra.push({
        table: "customer",
        key_value: customer.customer_id,
        column: "nationality",
        value: customer.nationality,
      });
    const country = evidence.countries[0];
    if (country?.country_link_id && country.country_iso2)
      extra.push({
        table: "list_country",
        key_value: country.country_link_id,
        column: "country_iso2",
        value: country.country_iso2,
      });
    const document = evidence.customerIdentifiers[0];
    if (document?.identifier_id && document.id_type)
      extra.push({
        table: "customer_identifier",
        key_value: document.identifier_id,
        column: "id_type",
        value: document.id_type,
      });
    const own = decision.output.facts as Fact[];
    // False alarms are measured on the decision exactly as it was made: its own citations, nothing changed.
    const unchanged = await review(deps, tools0(deps, evidence), evidence, match, decision.output);
    falseAlarm.push({
      alert_id: alertId,
      approved: unchanged.approved,
      fact_rejections: unchanged.issues
        .filter((i) => i.startsWith("cited fact does not hold"))
        .map((i) => i.slice(0, 120)),
    });
    const facts = [...own, ...extra];
    if (facts.length === 0) continue;
    decision.output = { ...decision.output, facts };
    const tools = buildEvidenceTools(evidence.model, clientFor(deps, "critic"), {
      role: "evidence",
      defaultLimit: config.zetaris.maxRows,
      maskSensitive: true,
    });
    const original = await review(deps, tools, evidence, match, decision.output);
    const factIssue = (issues: readonly string[]) => issues.some((i) => i.startsWith("cited fact does not hold"));
    // One mutation per cited fact that carries a value: each run of the critic sees exactly one false fact.
    for (const [index, fact] of facts.entries()) {
      if (fact.table === "memory" || fact.value === null || fact.value === "") continue;
      // A fact can only test the critic if its true value verifies: in sample mode a re-read that is not in the saved
      // answers cannot be made, and a column the critic may not read (id_number) is refused by design.
      const truth = original.checks[index];
      const untestable = truth?.ok !== true;
      const changed =
        fact.table === "customer_identifier"
          ? { fact: { ...fact, key_value: `${fact.key_value}-X9` }, kind: "made-up document (identifier) reference" }
          : mutate(fact);
      const mutated = await review(deps, tools, evidence, match, {
        ...decision.output,
        facts: facts.map((f, i) => (i === index ? changed.fact : f)),
      });
      rows.push({
        alert_id: alertId,
        decision: decision.output.decision,
        mutated: `${fact.table}.${fact.column}`,
        kind: changed.kind,
        caught: !mutated.approved && factIssue(mutated.issues),
        original_fact_alarm: factIssue(original.issues),
        original_approved: original.approved,
        testable: !untestable,
        why_untestable: untestable ? (truth?.reason ?? "no check").slice(0, 120) : undefined,
      });
    }
    decisionsTested += 1;
  } catch (err) {
    rows.push({ alert_id: alertId, error: String(err).slice(0, 160) });
  }
}
const done = rows.filter((r) => !r.error && r.testable);
const untestable = rows.filter((r) => !r.error && !r.testable);
const summary = {
  mode: "sample mode: saved Zetaris answers, rules-based stand-in for the models",
  decisions: decisionsTested,
  mutations: done.length,
  mutations_caught: done.filter((r) => r.caught).length,
  // A false alarm: a true cited fact (one whose value verifies) that the critic still rejected. By construction of the
  // testable set that cannot happen here; it is measured on the unchanged decisions as a whole below.
  untestable_citations: untestable.length,
  untestable_reasons: Object.fromEntries(
    [
      ...new Set(
        untestable.map((r) =>
          String(r.why_untestable)
            .replace(/\(HTTP.*$/, "")
            .slice(0, 70),
        ),
      ),
    ].map((k) => [k, untestable.filter((r) => String(r.why_untestable).startsWith(k)).length]),
  ),
  unchanged_decisions: falseAlarm.length,
  unchanged_decisions_approved: falseAlarm.filter((f) => f.approved).length,
  unchanged_decisions_with_a_true_fact_rejected: falseAlarm.filter((f) => f.fact_rejections.length > 0).length,
  unchanged_fact_rejection_reasons: [...new Set(falseAlarm.flatMap((f) => f.fact_rejections))].slice(0, 5),
  by_kind: Object.fromEntries(
    [...new Set(done.map((r) => r.kind as string))].map((k) => [
      k,
      `${done.filter((r) => r.kind === k && r.caught).length} of ${done.filter((r) => r.kind === k).length}`,
    ]),
  ),
  errors: rows.filter((r) => r.error).length,
};
console.log(JSON.stringify(summary, null, 2));
if (args.includes("--write"))
  writeFileSync(
    resolveProjectPath("eval/critic-mutation.json"),
    `${JSON.stringify({ at: new Date().toISOString(), summary, rows, unchanged: falseAlarm }, null, 2)}\n`,
  );
process.exit(done.length > 0 && summary.mutations_caught === done.length && true ? 0 : 1);

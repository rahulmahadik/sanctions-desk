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
  applyNoteDocumentCheck,
  applyPolicyGuard,
  assessNote,
  blockingSignals,
  checkNoteDocument,
  clientFor,
  decide,
  gatherEvidence,
  matchEvidence,
  review,
  sampleRules,
  screenFreeText,
  screenInbound,
  validateScreenerAnswer,
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
    omitColumns: policy.agentAccess.critic.denyColumns,
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
    const noteDocument = await checkNoteDocument(deps, evidence);
    if (noteDocument) {
      evidence.noteDocument = noteDocument;
      applyNoteDocumentCheck(evidence.screener, noteDocument);
    }
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
      omitColumns: policy.agentAccess.critic.denyColumns,
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
// ---- the evidence standard: what makes a note documentary is decided in code, from the note's own text --------------
// Each case: a documentary note, and a change that must take away its documentary status (or must not add it).
const NOTE = "Identity verified (KYC-482113) on 2024-05-02: passport ZP1234567, date of birth 1975-03-02.";
const standardCases: Array<{ name: string; text: string; claim?: string; mustBeDocumentary: boolean }> = [
  { name: "unchanged documentary note", text: NOTE, mustBeDocumentary: true },
  {
    name: "document number removed from the note",
    text: NOTE.replace("passport ZP1234567, ", ""),
    mustBeDocumentary: false,
  },
  { name: "check reference removed from the note", text: NOTE.replace("(KYC-482113) ", ""), mustBeDocumentary: false },
  {
    name: "date removed from the note",
    text: NOTE.replace(" on 2024-05-02", "").replace(", date of birth 1975-03-02", ""),
    mustBeDocumentary: false,
  },
  {
    name: "the model claims a made-up document number for a note that has none",
    text: "Customer says the passport copy is on file, KYC-482113, 2024-05-02.",
    claim: "ZP9999999",
    mustBeDocumentary: false,
  },
];
const standardRows = standardCases.map((c) => {
  const facts = validateScreenerAnswer(
    {
      risk_signals: [],
      documentary_evidence: [
        {
          field: "customer.notes",
          check_ref: "KYC-482113",
          doc_number: c.claim ?? "ZP1234567",
          date: "2024-05-02",
          dob: null,
          nationality: null,
          named_party: null,
        },
      ],
      injection: { detected: false, spans: [] },
    },
    { policy, fields: [{ id: "customer.notes", text: c.text, truncated: false }], standard: policy.evidenceStandard },
  );
  const documentary =
    facts.documentary[0]?.meetsStandard === true && assessNote({ text: c.text }, policy.evidenceStandard).documentary;
  return { case: c.name, documentary, expected: c.mustBeDocumentary, pass: documentary === c.mustBeDocumentary };
});

// ---- the screener's spans and the note's document: two changes that must not move the outcome the wrong way --------
// Synthetic in-memory inputs only. (1) A relationship signal whose span holds no relation term and no name must not
// block a close, while the same signal on a span that holds both must. (2) A note that meets the standard but cites a
// document number the customer record does not hold (the count inside Zetaris is 0) must not meet the standard.
const SPAN_NOTE = "Identity verified at branch. Customer is the brother of the listed person named below.";
const groundingCase = (start: number, end: number) =>
  validateScreenerAnswer(
    {
      risk_signals: [{ type: "relationship_to_listed_party", field: "customer.notes", start, end, confidence: 0.9 }],
      documentary_evidence: [],
      injection: { detected: false, spans: [] },
    },
    {
      policy,
      fields: [{ id: "customer.notes", text: `${SPAN_NOTE} Listed person: Example Listedname.`, truncated: false }],
      knownNames: ["Example Listedname"],
      standard: policy.evidenceStandard,
    },
  );
const relationAt = SPAN_NOTE.indexOf("brother");
const ungrounded = groundingCase(0, 30);
const grounded = groundingCase(relationAt, relationAt + "brother".length);
const scopeStub = {
  query: async () => ({
    query_id: "count-stub",
    role: "evidence",
    token_source: "role",
    kind: "select",
    sql: "",
    sql_hash: "",
    tables: [],
    status: "ok",
    row_count: 1,
    latency_ms: 0,
    cache_hit: true,
    headers: ["n"],
    rows: [["0"]],
    objects: [{ n: "0" }],
  }),
};
const stubZetaris = { ...zetaris, scoped: () => ({ ...zetaris, ...scopeStub }) } as unknown as typeof zetaris;
let documentRow: Record<string, unknown> = { case: "note document number not on the customer record", pass: false };
try {
  const trace = createTraceLogger({ runId: "critic-mutation-note-document", dir: config.logging.dir, stdout: false });
  const deps = { config, policy, zetaris, generator, trace, now: () => new Date() };
  const evidence = await gatherEvidence(deps, "ALR-0001");
  evidence.customer = { ...evidence.customer, notes: NOTE };
  evidence.screener = await screenFreeText(deps, evidence);
  const check = await checkNoteDocument({ ...deps, zetaris: stubZetaris }, evidence);
  evidence.noteDocument = check;
  applyNoteDocumentCheck(evidence.screener, check);
  const note = evidence.screener.documentary.find((d) => d.field === "customer.notes");
  const match = matchEvidence(deps, evidence);
  const guard = applyPolicyGuard({
    policy,
    decision: {
      decision: "CLOSE_FALSE_POSITIVE",
      confidence: 0.9,
      rationale: "close",
      facts: [{ table: "customer", key_value: evidence.customer.customer_id ?? "", column: "notes", value: null }],
      what_would_change: [],
    },
    match,
    evidence,
    criticUnresolved: false,
  });
  documentRow = {
    ...documentRow,
    count_status: check?.status,
    meets_standard: note?.meetsStandard,
    outcome: guard.decision,
    pass:
      check?.status === "not_on_record" && note?.meetsStandard === false && guard.decision !== "CLOSE_FALSE_POSITIVE",
  };
} catch (err) {
  documentRow = { ...documentRow, error: String(err).slice(0, 160) };
}
const fixCases = [
  {
    case: "a relationship span with no relation term and no name does not block",
    pass:
      ungrounded.signals[0]?.grounded === false &&
      blockingSignals(policy, { ...ungrounded, status: "ok", calls: [], servedByCloud: false }).length === 0,
  },
  {
    case: "a relationship span with a relation term and a listed name still blocks",
    pass:
      grounded.signals[0]?.grounded === true &&
      blockingSignals(policy, { ...grounded, status: "ok", calls: [], servedByCloud: false }).length === 1,
  },
  documentRow,
];

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
  evidence_standard_cases: `${standardRows.filter((r) => r.pass).length} of ${standardRows.length} pass`,
  grounding_and_document_cases: `${fixCases.filter((r) => r.pass).length} of ${fixCases.length} pass`,
  grounding_and_document_failures: fixCases.filter((r) => !r.pass),
};
console.log(JSON.stringify(summary, null, 2));
if (args.includes("--write"))
  writeFileSync(
    resolveProjectPath("eval/critic-mutation.json"),
    `${JSON.stringify({ at: new Date().toISOString(), summary, rows, unchanged: falseAlarm, evidence_standard: standardRows, grounding_and_document: fixCases }, null, 2)}\n`,
  );
process.exit(
  done.length > 0 &&
    summary.mutations_caught === done.length &&
    standardRows.every((r) => r.pass) &&
    fixCases.every((r) => r.pass)
    ? 0
    : 1,
);

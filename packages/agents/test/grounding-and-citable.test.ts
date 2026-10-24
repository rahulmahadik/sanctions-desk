import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { buildEvidenceTools, createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";
import { describe, expect, it } from "vitest";
import {
  applyNoteDocumentCheck,
  applyPolicyGuard,
  blockingSignals,
  checkNoteDocument,
  citableSources,
  type DecisionOutput,
  decisionPrompt,
  gatherEvidence,
  groundSignal,
  matchEvidence,
  NOT_ON_RECORD,
  review,
  runReview,
  ScreenerAnswerSchema,
  type ScreenerFacts,
  screenFreeText,
  validateScreenerAnswer,
} from "../src/index.js";
import { clientFor } from "../src/types.js";
import { caseFacts, quietPolicy, sampleDeps, sampleDepsWithText } from "./helpers.js";

/**
 * Span grounding (a screener signal counts only where its span says what it claims), the note's document number on
 * the customer record (one count inside Zetaris, the number never logged), exact offsets for the check reference and
 * the date, and the critic's handling of citations that cannot be cited at all.
 */

const policy = quietPolicy();
const LISTED = "Example Listedname";
const NOTE_TEXT = `Identity verified at branch. Customer is the brother of ${LISTED}, a listed person.`;
const field = (text: string) => [{ id: "customer.notes", text, truncated: false }];
const answerWith = (signals: Array<{ type: string; start: number; end: number; confidence?: number }>) =>
  ScreenerAnswerSchema.parse({
    risk_signals: signals.map((s) => ({ field: "customer.notes", confidence: 0.9, ...s })),
    documentary_evidence: [],
    injection: { detected: false, spans: [] },
  });
const asFacts = (v: ReturnType<typeof validateScreenerAnswer>): ScreenerFacts => ({
  ...v,
  status: "ok",
  calls: [],
  servedByCloud: false,
});

describe("span grounding", () => {
  const check = (text: string, start: number, end: number, type = "relationship_to_listed_party") =>
    validateScreenerAnswer(answerWith([{ type, start, end }]), {
      policy,
      fields: field(text),
      knownNames: [LISTED],
      standard: policy.evidenceStandard,
    });

  it("marks a relationship span with no relation term and no name as not grounded, keeps it, and it still blocks", () => {
    const facts = check(NOTE_TEXT, 0, 30);
    expect(facts.signals).toHaveLength(1);
    expect(facts.signals[0]?.grounded).toBe(false);
    expect(facts.signals[0]?.groundingReason).toMatch(/no relationship to listed party term/);
    expect(blockingSignals(policy, asFacts(facts))).toHaveLength(1);
  });

  it("grounds a span that holds the relation term with a listed name close by, and that signal blocks", () => {
    const at = NOTE_TEXT.indexOf("brother");
    const facts = check(NOTE_TEXT, at, at + "brother".length);
    expect(facts.signals[0]?.grounded).toBe(true);
    expect(blockingSignals(policy, asFacts(facts))).toHaveLength(1);
  });

  it("does not ground a relation term with no name from the evidence within the window", () => {
    const text = `The customer's brother runs a bakery.${" ".repeat(120)}${LISTED}`;
    const at = text.indexOf("brother");
    expect(check(text, at, at + 7).signals[0]?.grounded).toBe(false);
  });

  it("reads relation terms in other languages and names without accents or case", () => {
    const text = "Cliente es hijo de EXAMPLE LÍSTEDNAME según el registro.";
    const at = text.indexOf("hijo");
    const facts = validateScreenerAnswer(
      answerWith([{ type: "relationship_to_listed_party", start: at, end: at + 4 }]),
      {
        policy,
        fields: field(text),
        knownNames: ["Example Lístedname"],
        standard: policy.evidenceStandard,
      },
    );
    expect(facts.signals[0]?.grounded).toBe(true);
  });

  it("grounds a link to a watched place on the place itself, and not on a span without one", () => {
    const text = "Customer moved funds to a supplier in Tehran last year.";
    const at = text.indexOf("Tehran");
    expect(check(text, at, at + 6, "sanctioned_jurisdiction_link").signals[0]?.grounded).toBe(true);
    expect(check(text, 0, 20, "sanctioned_jurisdiction_link").signals[0]?.grounded).toBe(false);
  });

  it('leaves the injection type and "other" as before: they are not subject to grounding', () => {
    expect(check(NOTE_TEXT, 0, 30, "instruction_to_reviewer").signals[0]?.grounded).toBe(true);
    expect(check(NOTE_TEXT, 0, 30, "other").signals[0]?.grounded).toBe(true);
  });

  it("fails a span that does not point into the field", () => {
    const r = groundSignal({
      policy,
      fieldText: NOTE_TEXT,
      span: { start: 0, end: 999, valid: false },
      type: "relationship_to_listed_party",
      names: [LISTED],
    });
    expect(r).toEqual({ grounded: false, reason: "the span does not point into a field that was read" });
  });

  it("records a signal that is not grounded, shows it in the guard verdicts, and still blocks the close", async () => {
    const fp = caseFacts("fp_dob_exact_name_0");
    const deps = sampleDeps();
    const evidence = await gatherEvidence(deps, fp.alertId);
    const text = NOTE_TEXT;
    evidence.customer = { ...evidence.customer, notes: text };
    evidence.freeText = [...evidence.freeText, text];
    evidence.screener = asFacts(check(text, 0, 30));
    const match = matchEvidence(deps, evidence);
    const close: DecisionOutput = {
      decision: "CLOSE_FALSE_POSITIVE",
      confidence: 0.9,
      rationale: "The dates of birth conflict.",
      facts: [{ table: "customer", key_value: fp.customerId, column: "full_name", value: fp.customerName }],
      what_would_change: [],
    };
    const guard = applyPolicyGuard({ policy, decision: close, match, evidence, criticUnresolved: false });
    const grounding = guard.verdicts.find((v) => v.guard === "screener_grounding");
    expect(grounding?.verdict).toBe("flag");
    expect(grounding?.detail).toMatch(
      /not grounded in the text they point at \(shown for the reviewer; they still block a close\)/,
    );
    expect(guard.decision).not.toBe("CLOSE_FALSE_POSITIVE");
    expect(guard.verdicts.find((v) => v.guard === "screener")?.verdict).toBe("block");

    // The same span made grounded blocks the close, as before.
    const at = text.indexOf("brother");
    const groundedEvidence = { ...evidence, screener: asFacts(check(text, at, at + 7)) };
    const blocked = applyPolicyGuard({
      policy,
      decision: close,
      match: matchEvidence(deps, groundedEvidence),
      evidence: groundedEvidence,
      criticUnresolved: false,
    });
    expect(blocked.decision).not.toBe("CLOSE_FALSE_POSITIVE");
    expect(blocked.verdicts.find((v) => v.guard === "screener")?.verdict).toBe("block");
  });
});

describe("check reference and date come from exact spans", () => {
  it("records offsets whose text equals the value", () => {
    const text = "Seen at branch. Ref CDD 20931 dated 14 Mar 2024: passport ZP7654321 sighted.";
    const facts = validateScreenerAnswer(
      ScreenerAnswerSchema.parse({
        risk_signals: [],
        documentary_evidence: [{ field: "customer.notes", check_ref: "x", date: "14 mar 2024" }],
        injection: { detected: false, spans: [] },
      }),
      { policy, fields: field(text), standard: policy.evidenceStandard },
    );
    const d = facts.documentary[0];
    expect(d?.checkReferenceSpan).toBeDefined();
    expect(d?.dateSpan).toBeDefined();
    const ref = d?.checkReferenceSpan as { start: number; end: number; value: string };
    const date = d?.dateSpan as { start: number; end: number; value: string };
    expect(text.slice(ref.start, ref.end)).toBe(ref.value);
    expect(ref.value).toBe("CDD 20931");
    expect(d?.checkReference).toBe("CDD-20931");
    expect(text.slice(date.start, date.end)).toBe(date.value);
    expect(date.value).toBe("14 Mar 2024");
    expect(d?.date).toBe("2024-03-14");
  });
});

// ---- the note's document number on the customer record -------------------------------------------------------------

const DOC_NOTE = "Identity verified (KYC-482113) on 2024-05-02: passport ZP1234567, date of birth 1975-03-02.";
const NUMBER = "ZP1234567";

/** Sample deps whose note is DOC_NOTE, and whose count of matching customer documents is `count` (or no answer). */
function depsWithCount(count: number | "none") {
  const deps = sampleDepsWithText({ notes: DOC_NOTE });
  const sent: string[] = [];
  const inner = replayFetch(loadQueryCache(resolveProjectPath(deps.config.sampleCache)));
  const fetchImpl: typeof inner = async (url, init) => {
    const sql = String((JSON.parse(String(init?.body)) as { sql: string }).sql);
    if (sql.startsWith("SELECT COUNT(*) AS n FROM") && sql.includes("customer_identifier ci WHERE")) {
      sent.push(sql);
      if (count === "none") return new Response(JSON.stringify({ msg: "not saved" }), { status: 404 });
      return new Response(JSON.stringify({ headers: ["n"], data: [[String(count)]], total: 1 }), { status: 200 });
    }
    const res = await inner(url, init);
    if (res.status !== 200) return res;
    const body = JSON.parse(await res.text()) as { headers?: string[]; data?: unknown[][] };
    const at = body.headers?.indexOf("notes") ?? -1;
    if (at >= 0) for (const row of body.data ?? []) row[at] = DOC_NOTE;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { deps: { ...deps, zetaris: createZetarisClient({ config: deps.config, offline: true, fetchImpl }) }, sent };
}

/** Every file under a folder, as text. */
function allText(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? allText(path) : readFileSync(path, "utf8")))
    .join("\n");
}

describe("the note's document number on the customer record", () => {
  const fp = caseFacts("fp_dob_exact_name_0");

  it("not on the record: the note does not meet the standard and a close becomes NEED_MORE_INFO with the reason", async () => {
    const { deps, sent } = depsWithCount(0);
    const result = await runReview(deps, { runId: "note-doc-absent", alertId: fp.alertId, sampleMode: true });
    expect(sent).toHaveLength(1);
    expect(result.decision).toBe("NEED_MORE_INFO");
    const verdict = result.guards.find((g) => g.guard === "evidence_standard" && g.verdict === "block");
    expect(verdict?.detail).toContain(NOT_ON_RECORD);

    const record = JSON.parse(readFileSync(join(deps.logDir, "records", `rec-note-doc-absent.json`), "utf8"));
    const note = record.screener.documentary.find((d: { field: string }) => d.field === "customer.notes");
    expect(note.meets_standard).toBe(false);
    expect(note.missing).toContain(NOT_ON_RECORD);
    expect(note.document_check.status).toBe("not_on_record");
    expect(note.document_check.number_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sends the number to Zetaris only: no trace, record or log holds it", async () => {
    const { deps, sent } = depsWithCount(0);
    await runReview(deps, { runId: "note-doc-private", alertId: fp.alertId, sampleMode: true });
    expect(sent[0]).toContain(`'${NUMBER}'`);
    const written = allText(deps.logDir);
    expect(written).toContain("note_document_check");
    expect(written).not.toContain(NUMBER);
  });

  it("on the record: the note keeps the standard and the close stands", async () => {
    const { deps } = depsWithCount(1);
    const evidence = await gatherEvidence(deps, fp.alertId);
    evidence.screener = await screenFreeText(deps, evidence);
    const check = await checkNoteDocument(deps, evidence);
    expect(check?.status).toBe("on_record");
    applyNoteDocumentCheck(evidence.screener, check);
    const note = evidence.screener.documentary.find((d) => d.field === "customer.notes");
    expect(note?.meetsStandard).toBe(true);
    expect(note?.documentCheck?.status).toBe("on_record");
  });

  it("fails closed when the count cannot be made: not verified, with a reason, so not documentary", async () => {
    const { deps } = depsWithCount("none");
    const evidence = await gatherEvidence(deps, fp.alertId);
    evidence.screener = await screenFreeText(deps, evidence);
    const check = await checkNoteDocument(deps, evidence);
    expect(check?.status).toBe("not_verified");
    expect(check?.reason).toMatch(/sample mode has no saved answer for this check/);
    applyNoteDocumentCheck(evidence.screener, check);
    evidence.noteDocument = check;
    expect(evidence.screener.documentary.find((d) => d.field === "customer.notes")?.meetsStandard).toBe(false);
    // A note that could not be checked supplies no date of birth.
    expect(matchEvidence(deps, evidence).documentaryDateOfBirth).toBeUndefined();
  });

  it("does not run for a note that is only a claim", async () => {
    const deps = sampleDepsWithText({ notes: "Customer says the passport copy is on file." });
    const evidence = await gatherEvidence(deps, fp.alertId);
    expect(await checkNoteDocument(deps, evidence)).toBeUndefined();
  });
});

// ---- the critic and citations that cannot be cited -----------------------------------------------------------------

describe("citations that cannot be cited", () => {
  const fp = caseFacts("fp_dob_exact_name_0");
  const base = (facts: DecisionOutput["facts"]): DecisionOutput => ({
    decision: "CLOSE_FALSE_POSITIVE",
    confidence: 0.9,
    rationale: "The dates of birth conflict and the nationality differs.",
    facts,
    what_would_change: [],
  });
  const good = { table: "customer", key_value: fp.customerId, column: "full_name", value: fp.customerName };
  const uncitable = [
    { table: "customer", key_value: fp.customerId, column: "notes", value: "x" },
    { table: "customer_identifier", key_value: "IDN-1", column: "id_number", value: "x" },
    { table: "comparison", key_value: "x", column: "date_of_birth", value: "conflict" },
  ];

  async function setup() {
    const deps = sampleDeps();
    const evidence = await gatherEvidence(deps, fp.alertId);
    const match = matchEvidence(deps, evidence);
    const tools = buildEvidenceTools(evidence.model, clientFor(deps, "critic"), {
      role: "evidence",
      defaultLimit: deps.config.zetaris.maxRows,
      maskSensitive: true,
      omitColumns: deps.policy.agentAccess.critic.denyColumns,
    });
    return { deps, evidence, match, tools };
  }

  it("asks for the citation to be removed in the first round", async () => {
    const { deps, evidence, match, tools } = await setup();
    const verdict = await review(deps, tools, evidence, match, base([good, ...uncitable]), { round: 1 });
    expect(verdict.approved).toBe(false);
    const removals = verdict.issues.filter((i) => i.startsWith("remove this citation; it cannot be cited"));
    expect(removals).toHaveLength(3);
    expect(verdict.notCitable).toHaveLength(0);
  });

  it("sets them aside from the second round on, records them and judges the remaining facts", async () => {
    const { deps, evidence, match, tools } = await setup();
    const verdict = await review(deps, tools, evidence, match, base([good, ...uncitable]), { round: 2 });
    expect(verdict.notCitable.map((n) => `${n.table}.${n.column}`)).toEqual([
      "customer.notes",
      "customer_identifier.id_number",
      "comparison.date_of_birth",
    ]);
    expect(verdict.notCitable.every((n) => n.round === 2)).toBe(true);
    expect(verdict.issues.some((i) => i.startsWith("remove this citation"))).toBe(false);
    expect(verdict.approved).toBe(true);
  });

  it("still rejects a citable fact whose value does not hold, in any round", async () => {
    const { deps, evidence, match, tools } = await setup();
    const wrong = { ...good, value: `${fp.customerName} (changed)` };
    const verdict = await review(deps, tools, evidence, match, base([wrong, ...uncitable]), { round: 3 });
    expect(verdict.approved).toBe(false);
    expect(verdict.issues.some((i) => i.startsWith("cited fact does not hold"))).toBe(true);
  });

  it("tells the decision step exactly which tables and columns can be cited", async () => {
    const { deps, evidence, match } = await setup();
    const prompt = decisionPrompt(deps, evidence, match, []);
    const citable = JSON.parse(/<citable>(.*)<\/citable>/.exec(prompt)?.[1] ?? "{}");
    expect(citable).toEqual(citableSources(deps.policy, evidence.model));
    expect(citable.customer.columns).toContain("full_name");
    expect(citable.customer.columns).not.toContain("notes");
    expect(citable.customer_identifier.columns).not.toContain("id_number");
    expect(citable.comparison).toBeUndefined();
    expect(citable.customer_alias).toBeUndefined();
  });
});

describe("grounding can only add context, never remove a block", () => {
  // Every combination of type, confidence, span validity and grounding: a signal at or above its threshold blocks a
  // close whatever the grounding says, and grounding never turns a non-blocking signal into a blocking one either.
  const types = policy.screener.signalTypes;
  const confidences = [0, 0.3, 0.49, 0.5, 0.69, 0.7, 0.9, 1];
  it("blocks exactly by type and confidence, for every grounding outcome", () => {
    for (const type of types) {
      for (const confidence of confidences) {
        const blocksBy =
          confidence >=
          (type === "other" ? policy.screener.otherConfidenceThreshold : policy.screener.confidenceThreshold);
        const outcomes = [true, false].flatMap((grounded) =>
          [true, false].map((spanValid) => {
            const signal = {
              type,
              confidence,
              field: "customer.notes",
              spanId: "customer.notes:0-10",
              spanValid,
              grounded,
            } as const;
            const facts = {
              status: "ok",
              calls: [],
              servedByCloud: false,
              signals: [signal],
            } as unknown as ScreenerFacts;
            return blockingSignals(policy, facts).length > 0;
          }),
        );
        expect(outcomes, `${type} ${confidence}`).toEqual([blocksBy, blocksBy, blocksBy, blocksBy]);
      }
    }
  });
});

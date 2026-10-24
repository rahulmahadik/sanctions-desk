import { AppError, type NoteDocumentCheck, sha256Hex } from "@sanctions-desk/shared";
import type { UslModel } from "@sanctions-desk/zetaris";
import type { EvidenceBundle } from "./evidence.js";
import { assessNote, documentNumberSpan, normaliseDocumentNumber } from "./evidence-standard.js";
import { SCREENER_FIELDS, type ScreenerFacts } from "./screener.js";
import { type AgentDeps, clientFor } from "./types.js";

/**
 * The document number a note cites must be one of the customer's own documents. A note that meets the documentary
 * standard and names a document number is checked with one count inside Zetaris: how many of the customer's
 * identifier rows hold that number (both sides normalised: upper case, letters and digits only). Only the count comes
 * back. No model sees the number, and nothing written to the trace or the record holds it: they carry a hash of the
 * normalised number and the statement with the number replaced.
 *
 * A count of 0 means the note does not meet the standard, with a reason the reviewer sees. A count that cannot be made
 * (Zetaris refused or failed, or sample mode has no saved answer for it) fails closed: the note is not treated as
 * documentary, and the reason says the number was not verified.
 */

export const NOT_ON_RECORD = "document cited in note not on customer record";

const NOT_VERIFIED = "the document number in the note could not be checked against the customer record";

/** The count statement. The number is a run of capital letters and digits, so it needs no escaping. */
function noteDocumentSql(model: UslModel, customerId: string, normalisedNumber: string): string {
  const base = `${model.namespace}.${model.name}`;
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return (
    `SELECT COUNT(*) AS n FROM ${base}.customer_identifier ci ` +
    `WHERE ci.customer_id = ${q(customerId)} ` +
    `AND regexp_replace(upper(ci.id_number), '[^A-Z0-9]', '') = ${q(normalisedNumber)}`
  );
}

/** The statement as the trace and the record keep it: the number replaced by a marker that names its hash. */
function redactedNoteDocumentSql(sql: string, normalisedNumber: string, numberHash: string): string {
  return sql.replaceAll(`'${normalisedNumber}'`, `'<document number, sha256 ${numberHash.slice(0, 16)}>'`);
}

/** What a count says: on the record, not on it, or unreadable (and so not verified). */
function outcomeOf(n: number, numberHash: string, queryId: string): NoteDocumentCheck {
  if (!Number.isFinite(n))
    return {
      status: "not_verified",
      reason: `${NOT_VERIFIED} (the count came back unreadable)`,
      number_hash: numberHash,
      query_id: queryId,
    };
  return n > 0
    ? { status: "on_record", number_hash: numberHash, query_id: queryId }
    : { status: "not_on_record", reason: NOT_ON_RECORD, number_hash: numberHash, query_id: queryId };
}

/**
 * Check the customer note's document number against the customer record. Returns undefined when there is nothing to
 * check: no note, a note that does not meet the standard anyway, or no document number in it.
 */
export async function checkNoteDocument(
  deps: AgentDeps,
  evidence: EvidenceBundle,
): Promise<NoteDocumentCheck | undefined> {
  const notes = evidence.customer.notes;
  if (typeof notes !== "string" || !assessNote({ text: notes }, deps.policy.evidenceStandard).documentary)
    return undefined;
  const cited = documentNumberSpan(notes);
  if (!cited) return undefined;
  const normalised = normaliseDocumentNumber(cited.value);
  const numberHash = sha256Hex(normalised);
  const sql = noteDocumentSql(evidence.model, evidence.customer.customer_id ?? "", normalised);
  const redacted = redactedNoteDocumentSql(sql, normalised, numberHash);
  const role = deps.policy.masking.evidence;
  const input_summary = `document number cited in ${SCREENER_FIELDS.notes} (sha256 ${numberHash.slice(0, 16)}) against the customer's identifier rows`;

  let check: NoteDocumentCheck;
  try {
    // The evidence step's own access: the one agent identity that may read customer_identifier with its numbers.
    const result = await clientFor(deps, "evidence").query("evidence", sql);
    check = outcomeOf(Number(result.objects[0]?.n ?? Number.NaN), numberHash, result.query_id);
    evidence.queries.push({
      query_id: result.query_id,
      agent: "evidence",
      role,
      table: `${evidence.model.namespace}.${evidence.model.name}.customer_identifier`,
      sql: redacted,
      sql_hash: sha256Hex(redacted),
      redacted: true,
      row_count: result.rows.length,
      row_hashes: [],
      masked_columns: [],
      token_source: result.token_source,
      latency_ms: result.latency_ms,
      cache_hit: result.cache_hit,
    });
  } catch (err) {
    // The error text is not kept: a database message may quote the statement, and with it the number.
    const kind = err instanceof AppError ? err.type : "error";
    check = {
      status: "not_verified",
      reason: deps.config.sampleMode
        ? `${NOT_VERIFIED}: sample mode has no saved answer for this check, so the note is not treated as documentary`
        : `${NOT_VERIFIED} (${kind}), so the note is not treated as documentary`,
      number_hash: numberHash,
    };
  }
  deps.trace.log({
    agent: "evidence",
    action: "note_document_check",
    status: check.status === "on_record" ? "ok" : "blocked",
    target_agent: "policy_guard",
    input_summary,
    output_summary:
      check.status === "on_record"
        ? "the document number in the note is on the customer record"
        : (check.reason ?? check.status),
    ...(check.query_id ? { zetaris_query_id: check.query_id } : {}),
    detail: { status: check.status, number_hash: numberHash },
  });
  return check;
}

/**
 * Carry the check into the screener's documentary result for the customer note: the check is recorded, and a number
 * that is not on the record, or could not be checked, means the note does not meet the standard.
 */
export function applyNoteDocumentCheck(facts: ScreenerFacts | undefined, check: NoteDocumentCheck | undefined): void {
  if (!facts || !check) return;
  const reported = facts.documentary.some((d) => d.field === SCREENER_FIELDS.notes);
  if (!reported && facts.status === "ok" && check.status !== "on_record") {
    // The screener did not report the note; the check still belongs in its documentary result, so it is recorded.
    facts.documentary.push({
      field: SCREENER_FIELDS.notes,
      meetsStandard: false,
      missing: [],
      docNumberPresent: true,
      namedPartyPresent: false,
    });
  }
  for (const d of facts.documentary) {
    if (d.field !== SCREENER_FIELDS.notes) continue;
    d.documentCheck = check;
    if (check.status !== "on_record") {
      d.meetsStandard = false;
      const reason =
        check.status === "not_on_record" ? NOT_ON_RECORD : "a document number checked against the customer record";
      if (!d.missing.includes(reason)) d.missing.push(reason);
    }
  }
}

/**
 * The documentary-evidence standard. A free-text note, or a payment reference, counts as documentary evidence only
 * when it carries a check reference, a document number and a date (and, for a payment, a named counterparty).
 * Anything less is a claim: it is shown to the reviewer but it cannot clear a match, and a close that rests on it
 * goes to NEED_MORE_INFO.
 *
 * The test is deliberately plain. It looks for the three things a reviewer could go and check, not for whether the
 * note is believable.
 */

export interface EvidenceStandard {
  requireCheckReference: boolean;
  requireDocumentNumber: boolean;
  requireDate: boolean;
  requireNamedCounterpartyForPayments: boolean;
}

export const DEFAULT_EVIDENCE_STANDARD: EvidenceStandard = {
  requireCheckReference: true,
  requireDocumentNumber: true,
  requireDate: true,
  requireNamedCounterpartyForPayments: true,
};

/** A reference to the check that was made: "KYC-482113", "ref CDD 20931", "check no. 55120". */
const CHECK_REFERENCE =
  /\b(?:kyc|cdd|edd|chk|check|ref(?:erence)?|case)\b[\s:#.-]*(?:no\.?|number)?[\s:#.-]*[A-Z0-9-]*\d{4,}/i;

/** A document named, then its number (at least six digits): "passport ZP1234567", "council no. 2345678", "ID 12345678". */
const DOCUMENT_NUMBER =
  /\b(?:passport|identity card|id card|national id|id|licen[cs]e|council no\.?|company no\.?|registration(?: no\.?)?|document(?: no\.?)?)(?=[\s:#.-])[^.;()]{0,25}?\b([A-Z]{0,3}\d{6,})\b/i;

/** The check reference a note carries, or null. */
function checkReferenceOf(text: string | null | undefined): string | null {
  return CHECK_REFERENCE.exec(text ?? "")?.[0]?.trim() ?? null;
}

/** A stretch of a text: start inclusive, end exclusive, and the text at exactly those offsets. */
export interface SourceSpan {
  start: number;
  end: number;
  value: string;
}

const spanAt = (text: string, start: number, value: string): SourceSpan => ({
  start,
  end: start + value.length,
  value: text.slice(start, start + value.length),
});

/** Where the check reference stands in the text, exactly as written there, or null. */
export function checkReferenceSpan(text: string | null | undefined): SourceSpan | null {
  const t = text ?? "";
  const m = CHECK_REFERENCE.exec(t);
  return m ? spanAt(t, m.index, m[0]) : null;
}

/** Where the first date the standard accepts stands in the text, exactly as written there, or null. */
export function dateSpan(text: string | null | undefined): SourceSpan | null {
  const t = text ?? "";
  const m = DATE.exec(t);
  return m ? spanAt(t, m.index, m[0]) : null;
}

/** The text with its check reference blanked out, at the same length, so that offsets still point into the text. */
const withoutCheckReference = (text: string): string => text.replace(CHECK_REFERENCE, (m) => " ".repeat(m.length));

/**
 * The document number a note cites (the one the standard counts), exactly as written and where, or null. The check
 * reference never doubles as the document number.
 */
export function documentNumberSpan(text: string | null | undefined): SourceSpan | null {
  const t = text ?? "";
  const m = DOCUMENT_NUMBER.exec(withoutCheckReference(t));
  const number = m?.[1];
  if (!m || !number) return null;
  return spanAt(t, m.index + m[0].length - number.length, number);
}

/** A document number as compared with the customer's documents: upper case, letters and digits only. */
export const normaliseDocumentNumber = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\.?\\s+\\d{4}\\b`, "i");

/** The date of birth the text states as such ("born", "date of birth" or "dob" next to an ISO date), or null. */
export function labelledDateOfBirth(text: string | null | undefined): string | null {
  return /\b(?:born|date of birth|dob)\b[\s:]*(\d{4}-\d{2}-\d{2})\b/i.exec(text ?? "")?.[1] ?? null;
}

/** A check reference as a plain token: upper case, separators as single dashes ("ref CDD 20931" is "REF-CDD-20931"). */
export function normalisedCheckReference(text: string | null | undefined): string | null {
  const raw = checkReferenceOf(text);
  if (!raw) return null;
  const token = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[A-Z0-9-]{4,40}$/.test(token) ? token : null;
}

/**
 * The date of birth a documentary note states, or null. A note that is only a claim never supplies one.
 */
export function documentaryDateOfBirth(
  text: string | null | undefined,
  standard: EvidenceStandard = DEFAULT_EVIDENCE_STANDARD,
): { value: string; checkReference: string } | null {
  if (!assessNote({ text }, standard).documentary) return null;
  const value = labelledDateOfBirth(text);
  const checkReference = CHECK_REFERENCE.exec(text ?? "")?.[0]?.trim();
  return value && checkReference ? { value, checkReference } : null;
}

export interface NoteAssessment {
  /** True when every required element is present. */
  documentary: boolean;
  /** The required elements that are missing, in plain words. */
  missing: string[];
}

export interface NoteSource {
  text: string | null | undefined;
  /** Set for a payment reference: the counterparty it belongs to. */
  payment?: { counterpartyName: string | null | undefined };
}

const usableName = (name: string | null | undefined): boolean =>
  typeof name === "string" && name.trim().length >= 2 && !/^(unknown|n\/?a|none|-)$/i.test(name.trim());

export function assessNote(source: NoteSource, standard: EvidenceStandard = DEFAULT_EVIDENCE_STANDARD): NoteAssessment {
  const text = (source.text ?? "").trim();
  const missing: string[] = [];
  if (standard.requireCheckReference && !CHECK_REFERENCE.test(text)) missing.push("a check reference");
  // The check reference must not double as the document number.
  if (standard.requireDocumentNumber && !DOCUMENT_NUMBER.test(withoutCheckReference(text)))
    missing.push("a document number");
  if (standard.requireDate && !DATE.test(text)) missing.push("a date");
  if (standard.requireNamedCounterpartyForPayments && source.payment && !usableName(source.payment.counterpartyName))
    missing.push("a named counterparty");
  return { documentary: missing.length === 0, missing };
}

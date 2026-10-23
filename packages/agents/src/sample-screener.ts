/**
 * The labelled stand-in for the local screener model, used in sample mode and in tests. It answers the screener task
 * with patterns over the fields in the prompt and no language model, so a review runs end to end with no model
 * service. Its answer is checked by the same code as a real model's.
 */

/** Text that tries to instruct the reviewer or the system. Shared with the safety stand-in. */
export const INJECTION =
  /ignore (all )?(previous|prior|above) (instructions|rules)|disregard (the )?(above|system|previous)|you are now (a|an|the)|(reveal|print|show) .{0,30}(system prompt|api key|token|password)|<\/?\s*(system|assistant)\s*>/i;

interface FieldText {
  field: string;
  text: string;
}

interface Hit {
  type: string;
  start: number;
  end: number;
  confidence: number;
}

const SIGNAL_RULES: Array<{ type: string; pattern: RegExp; confidence: number; inRemarks?: boolean }> = [
  {
    type: "instruction_to_reviewer",
    pattern: new RegExp(
      `${INJECTION.source}|\\b(?:close|approve|clear|release) (?:this|the) (?:alert|case|payment)\\b`,
      "gi",
    ),
    confidence: 0.9,
  },
  {
    type: "alias_or_former_name",
    pattern:
      /\b(?:trad(?:es|ed|ing) (?:as|under)|doing business as|d\/b\/a|formerly(?: known as| named)?|also known as|a\.k\.a\.?|previously (?:known|named|operated)(?: as)?|former name|renamed from|operat(?:es|ed|ing) under the name)\b/gi,
    confidence: 0.85,
    inRemarks: true,
  },
  {
    type: "ownership_or_control_claim",
    pattern:
      /\b(?:owned by|controlled by|nominee (?:for|of)|acts? on behalf of|beneficial(?:ly)? owne[dr]|majority (?:owner|shareholder)|holds? \d+\s?%|\d+\s?% (?:owner|shareholder|stake))\b/gi,
    confidence: 0.75,
    inRemarks: true,
  },
  {
    type: "adverse_media",
    pattern: /\b(?:adverse media|convicted|indicted|arrested|charged with|bribery|corruption|money laundering)\b/gi,
    confidence: 0.75,
  },
];

const RELATION =
  /\b(?:introduced by|referred by|brother|sister|father|mother|son of|daughter of|wife|husband|spouse|cousin|nephew|niece|uncle|aunt|relative|brother-in-law|business partner|associate of|related to)\b/gi;

const nameTokens = (names: ReadonlyArray<string | null | undefined>): string[] =>
  names
    .flatMap((n) => (n ?? "").split(/[\s,]+/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hitsIn(field: FieldText, subject: string[], listed: string[], places: string[]): Hit[] {
  const hits: Hit[] = [];
  const remarks = field.field === "list_entry.remarks";
  // A list remark describes the listed party. It matters here only where it names the customer or the counterparty.
  if (remarks && !subject.some((t) => field.text.toLowerCase().includes(t))) return hits;
  for (const rule of SIGNAL_RULES) {
    if (remarks && !rule.inRemarks) continue;
    for (const m of field.text.matchAll(rule.pattern)) {
      hits.push({ type: rule.type, start: m.index, end: m.index + m[0].length, confidence: rule.confidence });
    }
  }
  if (remarks) return hits;
  for (const m of field.text.matchAll(RELATION)) {
    // A relationship is a risk when it points at the listed party; otherwise it is only noted, at low confidence.
    const near = field.text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 80).toLowerCase();
    const named = listed.some((t) => near.includes(t)) || /\b(?:listed|sanctioned|designated)\b/.test(near);
    hits.push({
      type: "relationship_to_listed_party",
      start: m.index,
      end: m.index + m[0].length,
      confidence: named ? 0.85 : 0.35,
    });
  }
  for (const place of places) {
    const m = new RegExp(`\\b${escapeRegExp(place)}\\b`, "i").exec(field.text);
    if (m) {
      hits.push({ type: "sanctioned_jurisdiction_link", start: m.index, end: m.index + m[0].length, confidence: 0.65 });
    }
  }
  return hits;
}

const CHECK_REF = /\b(?:KYC|CDD|EDD|CHK|REF|CASE)[\s:#-]*[A-Z0-9-]*\d{4,}/i;
const DOC_NUMBER =
  /\b(?:passport|identity card|id card|national id|licen[cs]e|ID)\b[^.;()]{0,25}?\b([A-Z]{0,3}\d{6,})\b/i;
const ANY_DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/i;
const DOB = /\b(?:born|birth|dob)\b[^0-9]{0,40}(\d{4}-\d{2}-\d{2})\b/i;
const NATIONALITY = /\b(?:nationality|citizen(?:ship)? of)[:\s]+([A-Za-z]{3,30})\b/i;

function documentaryOf(field: FieldText) {
  return {
    field: field.field,
    check_ref: CHECK_REF.exec(field.text)?.[0].trim() ?? null,
    doc_number: DOC_NUMBER.exec(field.text)?.[1] ?? null,
    date: ANY_DATE.exec(field.text)?.[0] ?? null,
    dob: DOB.exec(field.text)?.[1] ?? null,
    nationality: NATIONALITY.exec(field.text)?.[1] ?? null,
    named_party: null,
  };
}

function blockOf<T>(prompt: string, tag: string): T | null {
  try {
    return JSON.parse(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(prompt)?.[1] ?? "null") as T | null;
  } catch {
    return null;
  }
}

/** The stand-in's answer to a screener prompt, as the JSON text a model would return. */
export function screenerAnswer(prompt: string): string {
  const fields = blockOf<FieldText[]>(prompt, "fields") ?? [];
  const context = blockOf<Record<string, string | string[] | null>>(prompt, "context") ?? {};
  const policy = blockOf<{ watched_places?: string[] }>(prompt, "policy") ?? {};
  const subject = nameTokens([context.customer_name as string | null, context.counterparty_name as string | null]);
  const listed = nameTokens([
    context.listed_party_name as string | null,
    ...((context.listed_aliases as string[] | undefined) ?? []),
  ]);
  const places = (policy.watched_places ?? []).filter((p) => p.length > 2);

  const signals = fields.flatMap((f) => hitsIn(f, subject, listed, places).map((h) => ({ ...h, field: f.field })));
  const injection = signals.filter((s) => s.type === "instruction_to_reviewer");
  return JSON.stringify({
    analysis: "Rules-based stand-in for the local screener: pattern extraction, no language model.",
    risk_signals: signals.map((s) => ({
      type: s.type,
      field: s.field,
      start: s.start,
      end: s.end,
      confidence: s.confidence,
    })),
    documentary_evidence: fields
      .filter((f) => f.field === "customer.notes" || f.field === "payment.payment_reference")
      .map(documentaryOf),
    injection: {
      detected: injection.length > 0,
      spans: injection.map((s) => ({ field: s.field, start: s.start, end: s.end })),
    },
  });
}

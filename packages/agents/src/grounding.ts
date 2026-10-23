import type { Policy, ScreenerSignalType } from "@sanctions-desk/shared";

/**
 * Span grounding. A risk signal from the screener points at a field and a character range; it counts only when that
 * range really says what the signal claims. That is: the span lies inside the field, the span's own text holds a term
 * of the signal's type (the policy's list, in several languages), and a name from the evidence (the listed name or an
 * alias, the customer, the counterparty) is in the span or close to it. For a link to a watched place the place is
 * itself the entity. Everything compared is folded: no case, no accents.
 *
 * Pure code over the text and the policy. The result carries a reason in plain words and never the text itself.
 */

export interface GroundingResult {
  grounded: boolean;
  /** Why a signal is not grounded, or which check it was exempt from. Never quotes the text. */
  reason?: string;
}

export interface GroundingContext {
  policy: Policy;
  /** The full text of the field the span points into, or undefined when the field is not one that was read. */
  fieldText: string | undefined;
  span: { start?: number | undefined; end?: number | undefined; valid: boolean };
  type: ScreenerSignalType;
  /** Names from the structured evidence: listed name, aliases, customer and counterparty. */
  names: readonly string[];
}

/** Lower case, no accents. Lengths can change, so this is only applied to a slice that was cut first. */
export const foldText = (text: string): string => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Folded, and every run of characters that are not letters or digits turned into one space, padded with spaces. */
const words = (text: string): string =>
  ` ${foldText(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

const termCache = new Map<string, RegExp>();

/** A policy term as a regular expression over folded text: whole words, any spacing, "*" for a word ending. */
export function termPattern(term: string): RegExp {
  const cached = termCache.get(term);
  if (cached) return cached;
  const folded = foldText(term.trim());
  const open = folded.endsWith("*");
  const body = open ? folded.slice(0, -1) : folded;
  const source = body
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
  const before = isWordChar(body[0]) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = open ? "[\\p{L}\\p{N}]*" : isWordChar(body.at(-1)) ? "(?![\\p{L}\\p{N}])" : "";
  const re = new RegExp(`${before}${source}${after}`, "u");
  termCache.set(term, re);
  return re;
}

/** True when the text holds one of the terms. */
export function holdsTerm(text: string, terms: readonly string[]): boolean {
  const folded = foldText(text);
  return terms.some((t) => termPattern(t).test(folded));
}

/** The forms of the names a text may hold: each full name, and each word of it long enough and not generic. */
export function nameForms(names: readonly string[], policy: Policy): string[] {
  const g = policy.screener.grounding;
  const generic = new Set(g.genericNameWords.map((w) => foldText(w)));
  const forms = new Set<string>();
  for (const name of names) {
    const full = words(name).trim();
    if (full.length >= g.minNameTokenChars) forms.add(full);
    for (const token of full.split(" ")) {
      if (token.length >= g.minNameTokenChars && !generic.has(token)) forms.add(token);
    }
  }
  return [...forms];
}

/** True when the text holds one of the name forms as whole words. */
export function holdsName(text: string, forms: readonly string[]): boolean {
  const padded = words(text);
  return forms.some((f) => padded.includes(` ${f} `));
}

/** Watched places of the policy: the place names in every language given, and the country codes in capitals. */
function placeHit(policy: Policy, text: string): boolean {
  const watched = policy.jurisdictions.filter((j) => j.action === "escalate");
  if (
    holdsTerm(
      text,
      watched.flatMap((j) => j.keywords),
    )
  )
    return true;
  return watched.some((j) => new RegExp(`(?<![A-Za-z])${j.country}(?![A-Za-z])`).test(text));
}

const typeWords = (type: ScreenerSignalType): string => type.replaceAll("_", " ");

/** Whether one signal is grounded in the text it points at. */
export function groundSignal(c: GroundingContext): GroundingResult {
  const g = c.policy.screener.grounding;
  const terms = g.terms[c.type];
  const place = g.placeTypes.includes(c.type);
  if (!g.enabled || (!terms && !place)) return { grounded: true };
  const { start, end } = c.span;
  if (!c.span.valid || c.fieldText === undefined || start === undefined || end === undefined) {
    return { grounded: false, reason: "the span does not point into a field that was read" };
  }
  const spanText = c.fieldText.slice(start, end);
  if (place) {
    return placeHit(c.policy, spanText)
      ? { grounded: true }
      : { grounded: false, reason: "the span names no watched place of the policy" };
  }
  if (!holdsTerm(spanText, terms ?? [])) {
    return { grounded: false, reason: `the span holds no ${typeWords(c.type)} term of the policy` };
  }
  const forms = nameForms(c.names, c.policy);
  const window = c.fieldText.slice(Math.max(0, start - g.nameWindowChars), end + g.nameWindowChars);
  if (holdsName(spanText, forms) || holdsName(window, forms)) return { grounded: true };
  return {
    grounded: false,
    reason: `no listed name, alias, customer or counterparty name in the span or within ${g.nameWindowChars} characters of it`,
  };
}

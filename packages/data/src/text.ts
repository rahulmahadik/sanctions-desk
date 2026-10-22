/**
 * Text helpers shared by the parsers, the diff tool and the synthetic generator.
 */

/** Combining marks removed after NFKD decomposition (diacritics). */
const COMBINING_MARKS = /\p{M}+/gu;
/** Anything that is not a letter or a digit in any script. */
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

/** Latin letters that do not decompose into a base letter plus a mark, folded to their usual ASCII spelling. */
const LATIN_FOLDS: Readonly<Record<string, string>> = {
  ł: "l",
  đ: "d",
  ð: "d",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  þ: "th",
  ı: "i",
};
const LATIN_FOLD_PATTERN = new RegExp(`[${Object.keys(LATIN_FOLDS).join("")}]`, "gu");

/**
 * Canonical form of a name for comparison: compatibility-decomposed, diacritics removed, lower case,
 * punctuation and spacing collapsed. Scripts other than Latin are kept as they are.
 */
export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(LATIN_FOLD_PATTERN, (c) => LATIN_FOLDS[c] ?? c)
    .replace(NOT_LETTER_OR_DIGIT, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Arabic",
  "Han",
  "Hangul",
  "Japanese",
  "Hebrew",
  "Greek",
  "Devanagari",
  "Thai",
  "Armenian",
  "Georgian",
  "Other",
] as const;
export type Script = (typeof SCRIPTS)[number];

interface ScriptRange {
  script: Script;
  test: RegExp;
}

const SCRIPT_RANGES: readonly ScriptRange[] = [
  { script: "Latin", test: /\p{Script=Latin}/u },
  { script: "Cyrillic", test: /\p{Script=Cyrillic}/u },
  { script: "Arabic", test: /\p{Script=Arabic}/u },
  { script: "Han", test: /\p{Script=Han}/u },
  { script: "Hangul", test: /\p{Script=Hangul}/u },
  { script: "Japanese", test: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { script: "Hebrew", test: /\p{Script=Hebrew}/u },
  { script: "Greek", test: /\p{Script=Greek}/u },
  { script: "Devanagari", test: /\p{Script=Devanagari}/u },
  { script: "Thai", test: /\p{Script=Thai}/u },
  { script: "Armenian", test: /\p{Script=Armenian}/u },
  { script: "Georgian", test: /\p{Script=Georgian}/u },
];

/** The scripts that occur among the letters of a string, in a fixed order. */
export function scriptsIn(text: string): Script[] {
  const found = new Set<Script>();
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    const match = SCRIPT_RANGES.find((r) => r.test.test(char));
    found.add(match ? match.script : "Other");
  }
  return SCRIPTS.filter((s) => found.has(s));
}

/**
 * The script a name is written in. A name that mixes scripts (for example a Cyrillic "а" inside a
 * Latin word, the homoglyph trick) is reported as "Mixed" so callers can flag it.
 */
export function detectScript(text: string): Script | "Mixed" {
  const found = scriptsIn(text);
  if (found.length === 0) return "Latin";
  if (found.length > 1) return "Mixed";
  return found[0] as Script;
}

// ---- partial dates ---------------------------------------------------------------------------

export type DatePrecision = "day" | "month" | "year" | "range";

export interface PartialDate {
  /** ISO value at the stated precision: YYYY, YYYY-MM or YYYY-MM-DD. Null for a range. */
  value: string | null;
  precision: DatePrecision;
  /** For a range, the earliest and latest possible day. */
  rangeFrom: string | null;
  rangeTo: string | null;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function isoDay(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface YMD {
  year: number;
  month: number;
  day: number;
}

/**
 * Turn a "from ... to" window of possible days into the most precise honest description:
 * one day, a whole month, a whole year, or a range.
 */
export function describeWindow(from: YMD, to: YMD): PartialDate {
  const sameDay = from.year === to.year && from.month === to.month && from.day === to.day;
  if (sameDay) {
    return { value: isoDay(from.year, from.month, from.day), precision: "day", rangeFrom: null, rangeTo: null };
  }
  if (from.year === to.year && from.month === to.month && from.day === 1 && to.day === daysInMonth(to.year, to.month)) {
    return { value: `${pad(from.year, 4)}-${pad(from.month)}`, precision: "month", rangeFrom: null, rangeTo: null };
  }
  if (from.year === to.year && from.month === 1 && from.day === 1 && to.month === 12 && to.day === 31) {
    return { value: pad(from.year, 4), precision: "year", rangeFrom: null, rangeTo: null };
  }
  return {
    value: null,
    precision: "range",
    rangeFrom: isoDay(from.year, from.month, from.day),
    rangeTo: isoDay(to.year, to.month, to.day),
  };
}

/** Parse YYYY, YYYY-MM or YYYY-MM-DD into the window of days it covers. */
export function windowOfIso(value: string): { from: YMD; to: YMD } | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  if (m[2] === undefined) return { from: { year, month: 1, day: 1 }, to: { year, month: 12, day: 31 } };
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  if (m[3] === undefined) {
    return { from: { year, month, day: 1 }, to: { year, month, day: daysInMonth(year, month) } };
  }
  const day = Number(m[3]);
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { from: { year, month, day }, to: { year, month, day } };
}

/**
 * True when two partial dates can describe the same day. A year-only date is compatible with any
 * date in that year; used to decide whether a date of birth conflicts with a list entry.
 */
export function datesCompatible(a: string, b: string): boolean {
  const wa = windowOfIso(a);
  const wb = windowOfIso(b);
  if (!wa || !wb) return false;
  const key = (d: YMD) => d.year * 10000 + d.month * 100 + d.day;
  return key(wa.from) <= key(wb.to) && key(wb.from) <= key(wa.to);
}

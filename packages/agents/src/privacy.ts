import { AppError, watchedJurisdictions } from "@sanctions-desk/shared";
import type { z } from "zod";
import { recordCloudPayload } from "./cloud-payload.js";
import type { EvidenceBundle } from "./evidence.js";
import { type AskJsonOptions, type AskJsonResult, askJson } from "./model-call.js";
import type { AgentDeps } from "./types.js";

/**
 * Cloud privacy mode (config `privacyMode`, env PRIVACY_MODE; off by default). With "pseudonymise", before every cloud
 * call the case's names, identifiers, dates of birth, addresses and country values are replaced by stable per-case
 * tokens; the comparison code worked out stays, and each country token says whether the policy watches it. The token
 * map never leaves this machine (memory and the sealed record). If a raw name, identifier or date of birth is still in
 * the outgoing prompt, the call is not made.
 */

export type TokenKind = "party" | "listed" | "document" | "dob" | "country" | "address";

export interface PrivacyToken {
  token: string;
  kind: TokenKind;
  value: string;
}

export interface PrivacyMap {
  mode: "pseudonymise";
  tokens: PrivacyToken[];
}

const PREFIX: Record<TokenKind, string> = {
  party: "PARTY_",
  listed: "LISTED_",
  document: "DOC_",
  dob: "DOB_",
  country: "COUNTRY_",
  address: "ADDR_",
};
const TOKEN = /\b(?:PARTY_[A-Z]+|LISTED_\d+|DOC_\d+|DOB_\d+|COUNTRY_\d+|ADDR_\d+)\b/g;
/** Values compared as a whole JSON string only: a year or a country code is too short to replace inside text. */
const EXACT_ONLY: ReadonlySet<TokenKind> = new Set(["country", "dob"]);
const ADDRESS = /address|street|city|postcode|postal/;

const letters = (n: number): string => {
  let s = "";
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
};

const usable = (v: string | null | undefined): v is string => typeof v === "string" && v.trim().length >= 2;

/** The values of the case that leave the machine only as tokens, in a fixed order so the tokens are stable. */
function valuesOf(evidence: EvidenceBundle): Array<[TokenKind, string]> {
  const out: Array<[TokenKind, string]> = [];
  const add = (kind: TokenKind, v: string | null | undefined) => {
    if (usable(v)) out.push([kind, v.trim()]);
  };
  const c = evidence.customer;
  add("party", c.full_name);
  add("party", evidence.payment?.counterparty_name);
  for (const o of evidence.ownership?.rows ?? [])
    add(o.owner_party_kind === "listed" ? "listed" : "party", o.owner_name);
  add("listed", evidence.entry.primary_name);
  add("listed", evidence.alert.matched_name);
  for (const a of evidence.aliases) add("listed", a.alias_name);
  for (const doc of evidence.screener?.documentary ?? []) add("party", doc.namedParty);
  for (const i of evidence.customerIdentifiers) add("document", i.id_number);
  for (const i of evidence.listIdentifiers) add("document", i.id_number);
  add("dob", c.date_of_birth);
  for (const d of evidence.dobs) {
    add("dob", d.dob_value);
    add("dob", d.range_from);
    add("dob", d.range_to);
  }
  for (const doc of evidence.screener?.documentary ?? []) add("dob", doc.dob);
  for (const row of [c, evidence.payment ?? {}]) {
    for (const [k, v] of Object.entries(row)) if (ADDRESS.test(k)) add("address", v);
  }
  add("country", c.nationality);
  add("country", c.residence_country);
  for (const k of ["counterparty_country", "beneficiary_bank_country", "intermediary_bank_country"])
    add("country", evidence.payment?.[k]);
  for (const i of evidence.customerIdentifiers) add("country", i.issuing_country);
  for (const r of evidence.countries) add("country", r.country_iso2);
  for (const doc of evidence.screener?.documentary ?? []) add("country", doc.nationality);
  return out;
}

/** The case's token map, made once per case and kept on the evidence (and so in the sealed record). */
export function privacyMapOf(evidence: EvidenceBundle): PrivacyMap {
  if (evidence.privacy) return evidence.privacy;
  const tokens: PrivacyToken[] = [];
  const seen = new Map<string, string>();
  const counts: Record<TokenKind, number> = { party: 0, listed: 0, document: 0, dob: 0, country: 0, address: 0 };
  for (const [kind, value] of valuesOf(evidence)) {
    const key = kind === "country" ? `c:${value.toUpperCase()}` : value.toLowerCase();
    if (seen.has(key)) continue;
    const n = counts[kind]++;
    const token = PREFIX[kind] + (kind === "party" ? letters(n) : String(n + 1));
    seen.set(key, token);
    tokens.push({ token, kind, value });
  }
  evidence.privacy = { mode: "pseudonymise", tokens };
  return evidence.privacy;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A value inside text, not as part of a longer word or number. */
const inText = (value: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "giu");
const quoted = (value: string, flags = "g"): RegExp => new RegExp(`"${escapeRegExp(value)}"`, flags);

/** The prompt with every value of the map replaced by its token. Longer values first, so a name inside a name is safe. */
export function pseudonymise(text: string, map: PrivacyMap): string {
  let out = text;
  const order = [...map.tokens].sort((a, b) => b.value.length - a.value.length);
  for (const t of order) {
    out = out.replace(quoted(t.value, EXACT_ONLY.has(t.kind) && t.kind === "country" ? "gi" : "g"), `"${t.token}"`);
    if (!EXACT_ONLY.has(t.kind) && t.value.length >= 3) out = out.replace(inText(t.value), t.token);
    // A full date of birth is specific enough to replace inside text too; a year alone is not.
    if (t.kind === "dob" && /^\d{4}-\d{2}-\d{2}$/.test(t.value)) out = out.replace(inText(t.value), t.token);
  }
  return out;
}

/** Raw values of the case still in the text: names, identifiers and dates of birth. Empty means the text may go out. */
export function rawValuesIn(text: string, map: PrivacyMap): PrivacyToken[] {
  return map.tokens.filter((t) => {
    if (t.kind === "party" || t.kind === "listed" || t.kind === "document" || t.kind === "address") {
      return t.value.length >= 3 && inText(t.value).test(text);
    }
    if (t.kind === "dob") {
      return quoted(t.value).test(text) || (/^\d{4}-\d{2}-\d{2}$/.test(t.value) && inText(t.value).test(text));
    }
    return false;
  });
}

/** Every token in a value (a string, or the strings inside an object or array) mapped back to the raw value. */
export function restore<T>(value: T, map: PrivacyMap): T {
  const byToken = new Map(map.tokens.map((t) => [t.token, t.value]));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(TOKEN, (tok) => byToken.get(tok) ?? tok);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** What the tokens mean, and which country tokens the policy watches, added to a pseudonymised prompt. */
function tokenNote(deps: AgentDeps, map: PrivacyMap): string {
  const watched = new Set(watchedJurisdictions(deps.policy).map((j) => j.country.toUpperCase()));
  const countries = Object.fromEntries(
    map.tokens
      .filter((t) => t.kind === "country")
      .map((t) => [
        t.token,
        watched.has(t.value.toUpperCase()) ? "watched jurisdiction" : "not a watched jurisdiction",
      ]),
  );
  return [
    "<privacy>",
    "Names, identifiers, dates of birth, addresses and country codes of this case are replaced by tokens (PARTY_A, LISTED_1, DOC_1, DOB_1, COUNTRY_1, ADDR_1). The same value always has the same token. The comparison block was worked out by code on the real values: rely on it for name, date-of-birth and nationality agreement. Copy a token exactly when you cite a value.",
    `country_risk: ${JSON.stringify(countries)}`,
    "</privacy>",
  ].join("\n");
}

/**
 * One call of a cloud step (decision, critic, challenger). With privacy mode off it records the payload and asks the
 * model. With "pseudonymise" the prompt is tokenised, checked for raw values (the call is refused if any remain),
 * recorded, sent, and the answer is mapped back.
 */
export async function askCloud<T extends z.ZodType>(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  step: "decision" | "critic" | "challenger",
  options: AskJsonOptions<T>,
): Promise<AskJsonResult<z.infer<T>>> {
  if (deps.config.privacyMode !== "pseudonymise") {
    recordCloudPayload(deps, evidence, step, options.prompt);
    return askJson(deps, options);
  }
  const map = privacyMapOf(evidence);
  const prompt = `${pseudonymise(options.prompt, map)}\n${tokenNote(deps, map)}`;
  const system = pseudonymise(options.system, map);
  const left = rawValuesIn(`${system}\n${prompt}`, map);
  deps.trace.log({
    agent: step,
    action: "privacy",
    status: left.length > 0 ? "blocked" : "ok",
    output_summary:
      left.length > 0
        ? `not sent: ${left.length} raw value(s) of the case still in the prompt (${[...new Set(left.map((t) => t.kind))].join(", ")})`
        : `pseudonymised: ${map.tokens.length} value(s) of the case replaced by tokens`,
    detail: { tokens: map.tokens.length, kinds: [...new Set(map.tokens.map((t) => t.kind))], raw_left: left.length },
  });
  if (left.length > 0) {
    throw new AppError(
      "guard_blocked",
      `the ${step} prompt still holds ${left.length} raw value(s) of the case after pseudonymising, so it was not sent`,
      { recoverable: false },
    );
  }
  recordCloudPayload(deps, evidence, step, prompt);
  const result = await askJson(deps, { ...options, system, prompt });
  return { ...result, value: restore(result.value, map) };
}

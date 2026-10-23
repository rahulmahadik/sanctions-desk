import { type AgentName, AppError, type CloudPayload, sha256Hex } from "@sanctions-desk/shared";
import type { EvidenceBundle } from "./evidence.js";
import type { AgentDeps } from "./types.js";

/**
 * What a model-bound step was sent. The trace and the record keep the names of the fields and how many items each
 * held, and a hash of the whole prompt, so anyone can show what left the machine without the text being kept. If any
 * customer note, payment reference or list remark, or a run of 20 or more of its characters, is in the prompt, the
 * call is not made: the step treats that as a failure, and a failure never closes a case.
 */

/** The shortest run of characters from a free-text field that counts as a fragment of it. */
export const FRAGMENT_CHARS = 20;

/** The free text of the case that must never be in a prompt for a cloud step. */
export function freeTextOf(evidence: EvidenceBundle): string[] {
  return [evidence.customer.notes, evidence.payment?.payment_reference, evidence.entry.remarks].filter(
    (t): t is string => typeof t === "string" && t.trim() !== "",
  );
}

/**
 * Values the cloud models are sent on purpose (names, aliases, ids, dates, countries). A note may repeat them; such a
 * repeat is not a leak, so they are cut out of the text before it is compared with the prompt.
 */
function structuredValues(evidence: EvidenceBundle): string[] {
  const rows = [
    evidence.alert,
    evidence.customer,
    evidence.payment ?? {},
    evidence.entry,
    ...evidence.aliases,
    ...evidence.dobs,
    ...evidence.countries,
    ...evidence.customerIdentifiers,
  ];
  const skip = new Set(["notes", "payment_reference", "remarks"]);
  return rows
    .flatMap((r) => Object.entries(r).flatMap(([k, v]) => (!skip.has(k) && typeof v === "string" ? [v] : [])))
    .filter((v) => v.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
}

/** The pieces of a free-text field left once the structured values in it are cut out. */
function ownText(text: string, known: readonly string[]): string[] {
  let pieces = [text];
  for (const value of known) {
    const re = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    pieces = pieces.flatMap((p) => p.split(re));
  }
  return pieces.filter((p) => p.length >= FRAGMENT_CHARS);
}

/** The first run of FRAGMENT_CHARS of the piece found in the prompt, as written or escaped in JSON. */
function fragmentIn(
  prompt: string,
  runs: ReadonlySet<string>,
  sentAnyway: ReadonlySet<string>,
  piece: string,
): string | undefined {
  for (let i = 0; i + FRAGMENT_CHARS <= piece.length; i += 1) {
    const run = piece.slice(i, i + FRAGMENT_CHARS);
    if (run.trim().length < FRAGMENT_CHARS / 2 || sentAnyway.has(run)) continue;
    if (runs.has(run)) return run;
    const escaped = JSON.stringify(run).slice(1, -1);
    if (escaped !== run && prompt.includes(escaped)) return run;
  }
  return undefined;
}

/** Every run of FRAGMENT_CHARS characters in the prompt, so each window of the text is one lookup. */
function runsOf(prompt: string): Set<string> {
  const runs = new Set<string>();
  for (let i = 0; i + FRAGMENT_CHARS <= prompt.length; i += 1) runs.add(prompt.slice(i, i + FRAGMENT_CHARS));
  return runs;
}

/** What a free-text match looked like, without its text: which field, whole or fragment, what kind, where. */
export interface FreeTextMatch {
  field: "notes" | "payment_reference" | "remarks";
  kind: "whole" | "fragment";
  /** A coarse type of the matching characters, so a refusal can be told apart from a leak without keeping the text. */
  fragment_type: "date" | "check_reference" | "document_number" | "name" | "other";
  chars: number;
  fragment_hash: string;
  /** The prompt block (evidence, definitions, ...) that held it, when the prompt has blocks. */
  block?: string;
}

/** A coarse type for a run of characters. */
export function fragmentType(text: string): FreeTextMatch["fragment_type"] {
  if (/\d{4}-\d{2}-\d{2}/.test(text)) return "date";
  if (/\b[A-Z]{2,5}-\d{4,}\b/.test(text)) return "check_reference";
  if (/\b[A-Z]{0,3}\d{5,}[A-Z]?\b/.test(text)) return "document_number";
  if (/^[\p{L} .'-]+$/u.test(text) && /\p{Lu}/u.test(text)) return "name";
  return "other";
}

/** The first free text of the case, or fragment of it, found in the prompt; undefined when there is none. */
export function findFreeText(prompt: string, evidence: EvidenceBundle): FreeTextMatch | undefined {
  const fields = [
    ["notes", evidence.customer.notes],
    ["payment_reference", evidence.payment?.payment_reference],
    ["remarks", evidence.entry.remarks],
  ] as const;
  const present = fields.filter(
    (f): f is readonly [FreeTextMatch["field"], string] => typeof f[1] === "string" && f[1].trim() !== "",
  );
  if (present.length === 0) return undefined;
  const known = structuredValues(evidence);
  const runs = runsOf(prompt);
  // Runs that are also part of a value sent on purpose (a list name, an alias) or of the approved definitions' wording
  // are shared by coincidence of wording, not copied from the free text.
  const sentAnyway = new Set<string>();
  for (const value of [...known, ...evidence.definitions.map((d) => d.statement)]) {
    for (const run of runsOf(value)) sentAnyway.add(run);
  }
  const blocks = blocksOf(prompt);
  const blockOf = (text: string) => Object.entries(blocks).find(([, body]) => body.includes(text))?.[0];
  const describe = (field: FreeTextMatch["field"], kind: FreeTextMatch["kind"], text: string): FreeTextMatch => ({
    field,
    kind,
    fragment_type: fragmentType(text),
    chars: text.length,
    fragment_hash: sha256Hex(text).slice(0, 16),
    ...(blockOf(text) ? { block: blockOf(text) } : {}),
  });
  for (const [field, raw] of present) {
    const text = raw.trim();
    // A whole text is a leak from 8 characters on; shorter ones (or a text that is just a name sent anyway) are not
    // told apart from ordinary words.
    const whole =
      text.length >= 8 &&
      !known.some((k) => k.toLowerCase() === text.toLowerCase()) &&
      (prompt.includes(text) || prompt.includes(JSON.stringify(text).slice(1, -1)));
    if (whole) return describe(field, "whole", text);
    for (const piece of ownText(text, known)) {
      const run = fragmentIn(prompt, runs, sentAnyway, piece);
      if (run) return describe(field, "fragment", run);
    }
  }
  return undefined;
}

/** True when any free text of the case, or a fragment of it, appears in the prompt. */
export function containsFreeText(prompt: string, evidence: EvidenceBundle): boolean {
  return findFreeText(prompt, evidence) !== undefined;
}

function blocksOf(prompt: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  for (const m of prompt.matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)) blocks[m[1] as string] = m[2] as string;
  return blocks;
}

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : value === undefined ? 0 : 1);

/** Names and counts of what the prompt holds: its blocks, and the top-level fields of the evidence block. */
export function describePrompt(step: string, prompt: string, evidence: EvidenceBundle): CloudPayload {
  const blocks = blocksOf(prompt);
  const fields: Record<string, number> = {};
  for (const [name, body] of Object.entries(blocks)) {
    if (name !== "evidence") {
      fields[name] = 1;
      continue;
    }
    try {
      for (const [key, value] of Object.entries(JSON.parse(body) as Record<string, unknown>)) {
        if (value !== undefined && value !== null) fields[`evidence.${key}`] = countOf(value);
      }
    } catch {
      fields.evidence = 1;
    }
  }
  return {
    step,
    prompt_hash: sha256Hex(prompt),
    prompt_chars: prompt.length,
    fields,
    raw_free_text_present: containsFreeText(prompt, evidence),
  };
}

/**
 * Record what a cloud-bound step is about to send, in the run's trace and on the evidence for the sealed record. Throws
 * (type "guard_blocked") when free text of the case is in the prompt, so the call is never made; each step handles that
 * as a failure, which sends the case to a person.
 */
export function recordCloudPayload(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  step: AgentName,
  prompt: string,
): CloudPayload {
  const payload = describePrompt(step, prompt, evidence);
  // When the prompt is refused, say what matched (field, whole or fragment, coarse type, length, hash), never the text.
  const match = payload.raw_free_text_present ? findFreeText(prompt, evidence) : undefined;
  evidence.cloudPayloads = [...(evidence.cloudPayloads ?? []), payload];
  deps.trace.log({
    agent: step,
    action: "cloud_payload",
    status: payload.raw_free_text_present ? "blocked" : "ok",
    output_summary: payload.raw_free_text_present
      ? `not sent: free text from the data is in the prompt (hash ${payload.prompt_hash.slice(0, 16)})`
      : `sent ${Object.keys(payload.fields).length} fields, ${payload.prompt_chars} characters, hash ${payload.prompt_hash.slice(0, 16)}; free text withheld`,
    detail: { ...payload, ...(match ? { free_text_match: match } : {}) },
  });
  if (payload.raw_free_text_present) {
    throw new AppError(
      "guard_blocked",
      `the ${step} prompt holds free text from the data (a note, payment reference or list remark), so it was not sent`,
      { recoverable: false },
    );
  }
  return payload;
}

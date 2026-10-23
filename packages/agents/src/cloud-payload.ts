import { type AgentName, type CloudPayload, sha256Hex } from "@sanctions-desk/shared";
import type { EvidenceBundle } from "./evidence.js";
import type { AgentDeps } from "./types.js";

/**
 * What a model-bound step was sent. The trace and the record keep the names of the fields and how many items each
 * held, and a hash of the whole prompt, so anyone can show what left the machine without the text being kept. The
 * step also states whether any customer note, payment reference or list remark is in the payload; it must not be.
 */

/** Shorter texts are too likely to match something harmless (a country name, a currency) to be told apart. */
const MIN_TEXT_CHARS = 8;

/** The free text of the case that must never be in a prompt for a cloud step. */
export function freeTextOf(evidence: EvidenceBundle): string[] {
  return [evidence.customer.notes, evidence.payment?.payment_reference, evidence.entry.remarks].filter(
    (t): t is string => typeof t === "string" && t.trim().length >= MIN_TEXT_CHARS,
  );
}

/** True when any of the case's free text appears in the prompt, as written or as escaped inside JSON. */
export function containsFreeText(prompt: string, evidence: EvidenceBundle): boolean {
  return freeTextOf(evidence).some((t) => {
    const text = t.trim();
    return prompt.includes(text) || prompt.includes(JSON.stringify(text).slice(1, -1));
  });
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

/** Record what a cloud-bound step is about to send: in the run's trace, and on the evidence for the sealed record. */
export function recordCloudPayload(
  deps: AgentDeps,
  evidence: EvidenceBundle,
  step: AgentName,
  prompt: string,
): CloudPayload {
  const payload = describePrompt(step, prompt, evidence);
  evidence.cloudPayloads = [...(evidence.cloudPayloads ?? []), payload];
  deps.trace.log({
    agent: step,
    action: "cloud_payload",
    status: payload.raw_free_text_present ? "blocked" : "ok",
    output_summary: `sent ${Object.keys(payload.fields).length} fields, ${payload.prompt_chars} characters, hash ${payload.prompt_hash.slice(0, 16)}; free text ${payload.raw_free_text_present ? "PRESENT" : "withheld"}`,
    detail: { ...payload },
  });
  return payload;
}

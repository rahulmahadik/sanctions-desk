import type { Decision, Row } from "./types";

export const DECISION_LABEL: Record<Decision, string> = {
  CLOSE_FALSE_POSITIVE: "Close as false positive",
  ESCALATE_L2: "Escalate to level 2",
  RECOMMEND_BLOCK: "Recommend block (two approvals)",
  NEED_MORE_INFO: "Need more information",
};

/** The one palette for outcomes: block red, escalate amber, need more information blue, close green. */
export const DECISION_TONE: Record<Decision, "block" | "escalate" | "info" | "close"> = {
  CLOSE_FALSE_POSITIVE: "close",
  ESCALATE_L2: "escalate",
  RECOMMEND_BLOCK: "block",
  NEED_MORE_INFO: "info",
};

/** The icon beside each outcome's words, so colour is never the only signal. */
export const DECISION_ICON: Record<Decision, string> = {
  CLOSE_FALSE_POSITIVE: "✓",
  ESCALATE_L2: "▲",
  RECOMMEND_BLOCK: "⊘",
  NEED_MORE_INFO: "?",
};

export const MASK = "••••";

/** What to show for a field. A masked column is always drawn as dots, whatever the API sent. */
export function show(row: Row | null | undefined, column: string, masked: readonly string[] = []): string {
  if (masked.includes(column)) return MASK;
  const value = row?.[column];
  return value === null || value === undefined || value === "" ? "—" : value;
}

export const percent = (n: number): string => `${Math.round(n * 100)}%`;
export const seconds = (ms: number | undefined): string => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
export const money = (n: number, currency = "USD"): string =>
  `${n < 0.01 && n > 0 ? "<0.01" : n.toFixed(2)} ${currency}`;

export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : "—";
}

/** A short name for a model id. */
export function modelName(model: string): string {
  if (/ultra/i.test(model)) return "Nemotron 3 Ultra 550B";
  if (/lightning/i.test(model)) return "Nemotron 3.5 Lightning 30B";
  if (model === "fallback-rules") return "Rules stand-in (sample mode)";
  return model;
}

export const label = (text: string): string => text.replaceAll("_", " ");

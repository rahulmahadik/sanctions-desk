import type { Decision, Severity, StoppedBy } from "../lib/types";

/** The one palette: block red, escalate amber, need more information blue, close green, pending grey. */
export type Tone = "block" | "escalate" | "info" | "close" | "pending";

export const OUTCOME: Record<Decision | "pending", { tone: Tone; icon: string; text: string }> = {
  RECOMMEND_BLOCK: { tone: "block", icon: "⊘", text: "Block (two approvals)" },
  ESCALATE_L2: { tone: "escalate", icon: "▲", text: "Escalate" },
  NEED_MORE_INFO: { tone: "info", icon: "?", text: "Need more info" },
  CLOSE_FALSE_POSITIVE: { tone: "close", icon: "✓", text: "Close" },
  pending: { tone: "pending", icon: "○", text: "Not reviewed" },
};

export const outcomeTone = (d: Decision | null | undefined): Tone => OUTCOME[d ?? "pending"].tone;

/** An outcome badge: an icon and a word on the outcome's colour. */
export function OutcomeBadge({ decision }: { decision: Decision | null | undefined }) {
  const o = OUTCOME[decision ?? "pending"];
  return (
    <span className="pill" data-tone={o.tone} data-testid="outcome-badge">
      <span className="icon" aria-hidden="true">
        {o.icon}
      </span>
      {o.text}
    </span>
  );
}

const SEVERITY: Record<Severity, { tone: Tone; icon: string; text: string }> = {
  high: { tone: "block", icon: "▲", text: "High" },
  medium: { tone: "escalate", icon: "◆", text: "Medium" },
  low: { tone: "pending", icon: "▽", text: "Low" },
};

/** How strong the name match is (from the match score), with the rule in the tooltip. */
export function SeverityBadge({ severity, threshold }: { severity: Severity; threshold?: number }) {
  const s = SEVERITY[severity];
  const rule =
    severity === "high"
      ? "match score 0.95 or more"
      : severity === "medium"
        ? `match score at or above the policy's name threshold${threshold !== undefined ? ` (${threshold})` : ""}`
        : `match score below the policy's name threshold${threshold !== undefined ? ` (${threshold})` : ""}`;
  return (
    <span className="pill" data-tone={s.tone} title={rule} data-testid="severity-badge">
      <span className="icon" aria-hidden="true">
        {s.icon}
      </span>
      {s.text}
      <span className="sr-only"> severity: {rule}</span>
    </span>
  );
}

/** One chip per check that stopped a close the decision step had proposed. */
export function BlockedByChips({ by }: { by: readonly StoppedBy[] | undefined }) {
  if (!by || by.length === 0) return null;
  return (
    <>
      {by.map((b) => (
        <span key={b} className="pill chip" data-tone="block" data-testid="blocked-by">
          <span className="icon" aria-hidden="true">
            ⊘
          </span>
          blocked by {b}
        </span>
      ))}
    </>
  );
}

import { plainReason } from "../lib/format";
import type { CloseStopView, Decision } from "../lib/types";
import { BlockedByChips, OutcomeBadge, outcomeTone } from "./Badges";

/** The first sentence of the rationale, as the one-line reason. */
export function oneLine(rationale: string | undefined): string {
  const text = (rationale ?? "").trim();
  const end = text.search(/\.\s/);
  const first = end > 0 ? text.slice(0, end + 1) : text;
  return first.length > 220 ? `${first.slice(0, 219)}…` : first;
}

/**
 * The top of a case: the recommendation, a one-line reason, and, when the decision step proposed a close that a check
 * stopped, which check and why. A person decides either way.
 */
export function CaseBanner({
  decision,
  rationale,
  closeStop,
  alertType,
}: {
  decision: Decision | undefined;
  rationale?: string;
  closeStop?: CloseStopView | null;
  /** Whose name the comparison is about: the payment counterparty's on a payment alert. */
  alertType?: string | null;
}) {
  if (!decision) return null;
  return (
    <section
      className="panel case-banner"
      data-tone={outcomeTone(decision)}
      aria-label="Recommendation"
      data-testid="case-banner"
    >
      <OutcomeBadge decision={decision} /> <span className="muted">Recommendation; a person decides.</span>
      <p className="reason" data-testid="case-reason">
        {plainReason(oneLine(rationale), alertType) || "No reason was recorded."}
      </p>
      {closeStop?.stopped ? (
        <p className="reason" data-testid="case-stopped">
          The decision step proposed a close; it was stopped. <BlockedByChips by={closeStop.by} />
          {closeStop.reasons.length > 0 ? (
            <span className="muted"> {closeStop.reasons.map((r) => plainReason(r, alertType)).join("; ")}</span>
          ) : null}
        </p>
      ) : closeStop ? (
        <p className="reason muted" data-testid="case-stopped">
          No close was proposed and stopped in this review.
        </p>
      ) : null}
    </section>
  );
}

import { API_URL } from "../lib/api";
import { modelName, seconds } from "../lib/format";
import { type GraphView, STEPS, type StepView } from "../lib/graph";
import type { CloseStopView, StoppedBy } from "../lib/types";

const STATE_TEXT: Record<string, string> = {
  idle: "waiting",
  running: "working now",
  done: "done",
  retry: "trying again",
  flagged: "flagged",
  error: "problem",
  skipped: "skipped",
};

/** Which node each kind of check belongs to. A data-quality rule is applied by the policy guard. */
const STEP_OF: Record<StoppedBy, string> = {
  critic: "critic",
  "policy guard": "policy_guard",
  screener: "screener",
  "data quality": "policy_guard",
};

/** For each step that stopped a close the decision step proposed, the reasons it gave. */
export function stoppedSteps(stop: CloseStopView | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!stop?.stopped) return out;
  for (const by of stop.by) {
    const id = STEP_OF[by];
    const reasons = stop.reasons.filter((r) =>
      by === "critic" ? r.startsWith("critic") : by === "screener" ? r.startsWith("screener") : !r.startsWith("critic"),
    );
    out[id] = [out[id], ...reasons].filter(Boolean).join("; ") || `stopped by the ${by}`;
  }
  return out;
}

/** Where a model step ran and which model served it, with its signed receipt. */
function ModelChips({ step }: { step: StepView }) {
  if (!step.model) return null;
  const where = step.route ?? "local";
  const backup = step.provider === "ollama";
  return (
    <div className="state">
      <span className={`lane-${where}`} data-testid={`model-chip-${step.id}`}>
        {backup ? "backup " : ""}
        {where} {modelName(step.model).replace("Nemotron 3.5 ", "").replace("Nemotron 3 ", "")}
      </span>
      {step.latencyMs !== undefined ? ` · ${seconds(step.latencyMs)}` : ""}
      <div title={step.requested ? `requested ${step.requested}` : undefined}>routed {step.model}</div>
      {step.receiptId ? (
        <>
          <a
            href={`${API_URL}/receipts/${encodeURIComponent(step.receiptId)}/verify`}
            target="_blank"
            rel="noreferrer"
            data-testid={`receipt-link-${step.id}`}
            // Opening the receipt is not a jump in the replay.
            onClick={(e) => e.stopPropagation()}
          >
            receipt {step.receiptId}
          </a>
          <div data-testid={`receipt-check-${step.id}`}>
            {step.receiptRejected ? `answer not used: ${step.receiptRejected}` : receiptWords(step.receiptCheck)}
          </div>
        </>
      ) : (
        <div data-testid={`receipt-check-${step.id}`}>
          {step.receiptRejected ? `answer not used: ${step.receiptRejected}` : noReceiptWords(step.provider)}
        </div>
      )}
    </div>
  );
}

function receiptWords(check?: string): string {
  if (check === "valid_pinned") return "signature valid, key pinned";
  if (check === "valid_unpinned") return "signature valid, key from the receipt";
  if (check === "invalid" || check === "malformed") return `receipt ${check}`;
  return "receipt not checked yet";
}

function noReceiptWords(provider?: string): string {
  if (provider === "ollama") return "Ollama backup, no receipt (on this machine, not through Nightshift)";
  if (provider === "fallback-rules") return "sample mode: rules stand-in, not a model";
  return "no receipt";
}

function StepNode({
  step,
  reason,
  finished,
  onSelect,
}: {
  step: StepView;
  reason?: string;
  finished: boolean;
  /** Only in the replay, and only for a step with recorded events: jump to its last event. */
  onSelect?: () => void;
}) {
  const model = STEPS.find((s) => s.id === step.id)?.model;
  const head = (
    <>
      <strong>{step.label}</strong>
      <div className="state">
        {reason
          ? "stopped a close"
          : finished && step.state === "idle"
            ? "not run in this review"
            : STATE_TEXT[step.state]}
        {step.retries > 0 ? ` · ${step.retries} ${step.retries === 1 ? "retry" : "retries"}` : ""}
      </div>
    </>
  );
  return (
    <li
      className="node"
      data-state={step.state}
      data-blocked={reason ? "true" : undefined}
      title={reason ? `Stopped a close: ${reason}` : step.lastSummary}
      aria-current={step.state === "running" ? "step" : undefined}
      data-testid={`node-${step.id}`}
    >
      {onSelect ? (
        <button
          type="button"
          className="node-jump"
          aria-label={`Jump to the last event of ${step.label}`}
          onClick={onSelect}
          data-testid={`jump-${step.id}`}
        >
          {head}
        </button>
      ) : (
        head
      )}
      {reason ? <span className="sr-only">Reason: {reason}</span> : null}
      {model ? <ModelChips step={step} /> : null}
    </li>
  );
}

/**
 * One node per review step. The light on each node comes from recorded events, never from a timer; the step working
 * now is outlined, and a step that stopped a proposed close is red with its reason on hover.
 */
export function RunGraph({
  view,
  stopped = {},
  onSelect,
  selectable,
}: {
  view: GraphView;
  stopped?: Record<string, string>;
  /** In the replay: called with a step's id when the person clicks its box. Without it the boxes are not buttons. */
  onSelect?: (stepId: string) => void;
  /** The steps that have recorded events; only those can be clicked. */
  selectable?: ReadonlySet<string>;
}) {
  return (
    <section aria-labelledby="graph-title" className="panel">
      <h2 id="graph-title">Review steps</h2>
      <ol className="flow">
        {view.steps.map((step) => (
          <StepNode
            key={step.id}
            step={step}
            reason={stopped[step.id]}
            finished={view.finished}
            onSelect={onSelect && (selectable?.has(step.id) ?? true) ? () => onSelect(step.id) : undefined}
          />
        ))}
      </ol>
      <p className="muted" data-testid="critic-rounds">
        Critic rounds: {view.criticRound} of {view.criticMaxRounds} allowed
        {view.failed ? " · the run ended with a problem" : view.finished ? " · finished" : ""}
      </p>
    </section>
  );
}

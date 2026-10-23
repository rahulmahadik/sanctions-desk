import { label, seconds } from "../lib/format";
import { type GraphView, STEPS } from "../lib/graph";

const STATE_TEXT: Record<string, string> = {
  idle: "waiting",
  running: "working",
  done: "done",
  retry: "trying again",
  error: "problem",
  skipped: "skipped",
};

/** One node per review step. The light on each node comes from recorded events, never from a timer. */
export function RunGraph({ view }: { view: GraphView }) {
  return (
    <section aria-labelledby="graph-title" className="panel">
      <h2 id="graph-title">Review steps</h2>
      <ol className="flow">
        {view.steps.map((step) => {
          const model = STEPS.find((s) => s.id === step.id)?.model;
          return (
            <li key={step.id} className="node" data-state={step.state} data-testid={`node-${step.id}`}>
              <strong>{step.label}</strong>
              <div className="state">
                {STATE_TEXT[step.state]}
                {step.retries > 0 ? ` · ${step.retries} ${step.retries === 1 ? "retry" : "retries"}` : ""}
              </div>
              {model && step.model ? (
                <div className="state">
                  <span className={`lane-${step.route ?? "local"}`}>{step.route ?? "local"}</span> · {label(step.model)}
                  {step.latencyMs !== undefined ? ` · ${seconds(step.latencyMs)}` : ""}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="muted" data-testid="critic-rounds">
        Critic rounds: {view.criticRound} of {view.criticMaxRounds} allowed
        {view.failed ? " · the run ended with a problem" : view.finished ? " · finished" : ""}
      </p>
    </section>
  );
}

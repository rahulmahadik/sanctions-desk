import { FINAL_CALL, type ReadProblem } from "../lib/format";

/** What sample mode is, when the API sent no notice of its own. */
export const SAMPLE_LINE =
  "Sample mode: the data is replayed from saved real answers and the model is a labelled rules-based stand-in.";

/**
 * Always visible: the desk recommends, a person makes the final call. In sample mode one line says so: the API's own
 * notice when the answer carries one, otherwise the same idea in the interface's words, never both.
 */
export function HumanBanner({ sampleMode, notice }: { sampleMode?: boolean; notice?: string }) {
  return (
    <>
      <p className="banner" role="note">
        The desk only recommends. {FINAL_CALL} Nothing here blocks an account, writes to a source system or contacts a
        customer.
      </p>
      {sampleMode ? (
        <p className="banner" role="note" data-testid="sample-notice">
          {notice?.trim() ? notice : SAMPLE_LINE}
        </p>
      ) : null}
    </>
  );
}

/** A failed read: a missing sign-in is a neutral note saying what to do, any other failure a red alert. */
export function ProblemNote({ problem, lead }: { problem: ReadProblem; lead?: string }) {
  return problem.signIn ? (
    <p className="panel" role="status" data-testid="sign-in-note">
      {problem.text}
    </p>
  ) : (
    <p className="panel tone-stop" role="alert">
      {lead ? `${lead}: ` : ""}
      {problem.text}
    </p>
  );
}

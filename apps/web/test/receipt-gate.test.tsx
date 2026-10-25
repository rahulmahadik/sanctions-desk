// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunGraph } from "../components/RunGraph";
import { graphAt } from "../lib/graph";
import type { RunEvent } from "../lib/types";

afterEach(cleanup);

const answer = (over: Partial<RunEvent>): RunEvent => ({
  ts: "2026-01-01T00:00:00.000Z",
  run_id: "r",
  seq: 1,
  agent: "decision",
  action: "model_answer",
  status: "retry",
  model_used: "nvidia/nemotron-3-ultra-550b-a55b",
  provider: "nightshift",
  route_kind: "cloud",
  ...over,
});

describe("the step chip when an answer's receipt is rejected", () => {
  it("says the answer was not used because of its receipt", () => {
    const view = graphAt([
      answer({
        receipt: { receipt_id: "r-1", verification: "invalid" },
        detail: { receipt_rejected: "receipt invalid" },
      }),
    ]);
    render(<RunGraph view={view} />);
    expect(screen.getByTestId("receipt-check-decision").textContent).toBe("answer not used: receipt invalid");
  });

  it("says so for a Nightshift answer that came with no receipt at all", () => {
    render(<RunGraph view={graphAt([answer({ detail: { receipt_rejected: "receipt missing" } })])} />);
    expect(screen.getByTestId("receipt-check-decision").textContent).toBe("answer not used: receipt missing");
  });

  it("still labels an Ollama backup answer as having no receipt", () => {
    render(
      <RunGraph
        view={graphAt([
          answer({ status: "ok", provider: "ollama", route_kind: "local", model_used: "nemotron-3.5-lightning:30b" }),
        ])}
      />,
    );
    expect(screen.getByTestId("receipt-check-decision").textContent).toContain("no receipt");
  });
});

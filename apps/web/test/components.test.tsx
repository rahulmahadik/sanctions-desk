// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceCards } from "../components/Evidence";
import { ExamDashboard } from "../components/ExamDashboard";
import { Queue } from "../components/Queue";
import { Outcome, Replay } from "../components/Record";
import { RoutingPanel } from "../components/Routing";
import { RunGraph } from "../components/RunGraph";
import { graphAt } from "../lib/graph";
import type { ExamAnswer, QueueAlert } from "../lib/types";
import { ANSWER, EVENTS, EVIDENCE, RECORD, TRACE } from "./fixtures";

vi.mock("../lib/api", () => ({
  fetchQueue: vi.fn(),
  fetchExam: vi.fn(),
  fetchEvidence: vi.fn(),
  fetchTrace: vi.fn(),
  fetchRecord: vi.fn(),
  fetchEvents: vi.fn(),
  startReview: vi.fn(),
  followRun: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { CaseView } from "../components/CaseView";
import * as api from "../lib/api";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("RunGraph", () => {
  it("draws every step, the critic round count and where the models ran", () => {
    render(<RunGraph view={graphAt(EVENTS)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
    expect(screen.getByTestId("node-decision").textContent).toContain("1 retry");
    expect(screen.getByTestId("node-decision").textContent).toContain("local");
    expect(screen.getByTestId("critic-rounds").textContent).toContain("2 of 3");
    expect(screen.getByTestId("critic-rounds").textContent).toContain("finished");
  });

  it("marks the working step with a state the styles can show without motion", () => {
    render(<RunGraph view={graphAt(EVENTS, 4)} />);
    expect(screen.getByTestId("node-matching").getAttribute("data-state")).toBe("running");
  });
});

describe("EvidenceCards", () => {
  it("shows identifier numbers as dots and says why", () => {
    render(<EvidenceCards view={EVIDENCE} />);
    expect(screen.getByText("••••")).toBeTruthy();
    expect(screen.queryByText("******56")).toBeNull();
    expect(screen.getByText(/masked for the evidence role/)).toBeTruthy();
  });

  it("shows a failing data-quality rule and the payment route", () => {
    render(<EvidenceCards view={EVIDENCE} />);
    expect(screen.getByText(/dob_present_for_individuals fails/)).toBeTruthy();
    const payment = screen.getByLabelText("Payment");
    expect(within(payment).getByText("CU")).toBeTruthy();
    expect(within(payment).getByText("IR")).toBeTruthy();
  });

  it("says when the case has no payment, no identifiers and no failing rule", () => {
    render(
      <EvidenceCards
        view={{
          ...EVIDENCE,
          payment: null,
          customer_identifiers: [],
          data_quality: [],
          identifier_overlap: ["passport"],
        }}
      />,
    );
    expect(screen.queryByLabelText("Payment")).toBeNull();
    expect(screen.getByText("None on file.")).toBeTruthy();
    expect(screen.getByText(/passes for these records|Every data-quality rule passes/)).toBeTruthy();
    expect(screen.getByText(/matches a listed one \(passport\)/)).toBeTruthy();
  });
});

describe("RoutingPanel", () => {
  it("shows model, lane, receipt status and cost per step", () => {
    render(<RoutingPanel trace={TRACE} />);
    const row = screen.getByText("nvidia/nemotron-3-ultra-550b-a55b").closest("tr");
    expect(row?.textContent).toContain("cloud");
    expect(row?.textContent).toContain("valid pinned");
    expect(row?.textContent).toContain("0.02 USD");
    expect(screen.getByText(/Unit costs are assumptions/)).toBeTruthy();
  });

  it("says so when no model was called", () => {
    render(<RoutingPanel trace={{ ...TRACE, cost: { ...TRACE.cost, models: [] } }} />);
    expect(screen.getByText(/No model was called/)).toBeTruthy();
  });
});

describe("Outcome", () => {
  it("shows the recommendation, what would change it and that a person decides", () => {
    render(<Outcome answer={ANSWER} />);
    expect(screen.getByTestId("verdict").textContent).toBe("Close as false positive");
    expect(screen.getByText(/A person decides/)).toBeTruthy();
    expect(screen.getByText("A matching identifier number")).toBeTruthy();
    expect(screen.getByText(/critic: approved after 2 rounds/)).toBeTruthy();
  });

  it("shows a failed review as a failure, never as a decision", () => {
    render(
      <Outcome
        answer={{ ...ANSWER, status: "error", decision: undefined, error: { type: "x", message: "Zetaris is down" } }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Zetaris is down");
    expect(screen.queryByTestId("verdict")).toBeNull();
  });

  it("says when a recommendation needs two approvals", () => {
    render(<Outcome answer={{ ...ANSWER, decision: "RECOMMEND_BLOCK", approvals_required: 2 }} />);
    expect(screen.getByText(/needs 2 approvals/)).toBeTruthy();
  });
});

describe("Replay", () => {
  it("replays the run as of any event: the steps and the line shown follow the slider", () => {
    render(<Replay events={EVENTS} record={RECORD} />);
    expect(screen.getByText(/using data and policy as of 2026-10-22/)).toBeTruthy();
    const slider = screen.getByLabelText(/Event 12 of 12/);
    fireEvent.change(slider, { target: { value: "4" } });
    expect(screen.getByTestId("node-matching").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("replay-current").textContent).toContain("matching");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(screen.getByTestId("replay-current").textContent).toBe("Before the run started");
  });
});

const ALERTS: QueueAlert[] = [
  {
    alert_id: "ALR-0001",
    alert_type: "customer",
    alert_source: "customer_name",
    customer_id: "C1",
    entry_id: "E1",
    matched_name: "JANE DOE",
    match_score: 0.93,
    status: "open",
    recommendation: null,
    record_hash: null,
  },
  {
    alert_id: "ALR-0002",
    alert_type: "payment",
    alert_source: "payment",
    customer_id: "C2",
    entry_id: "E2",
    matched_name: "ACME",
    match_score: 0.88,
    status: "open",
    recommendation: "ESCALATE_L2",
    record_hash: "c".repeat(64),
  },
];

describe("Queue", () => {
  it("lists alerts with their recommendation and filters them", async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue({ alerts: ALERTS, sample_mode: true });
    render(<Queue />);
    expect(await screen.findByText("ALR-0001")).toBeTruthy();
    expect(screen.getByText(/Sample mode/)).toBeTruthy();
    expect(screen.getByText("Escalate to level 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Show/), { target: { value: "reviewed" } });
    expect(screen.queryByText("ALR-0001")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Show/), { target: { value: "open" } });
    expect(screen.queryByText("ALR-0002")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Show/), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "payment" } });
    expect(screen.getByText("1 of 2 alerts")).toBeTruthy();
  });

  it("says plainly when the queue cannot be read", async () => {
    vi.mocked(api.fetchQueue).mockRejectedValue(new Error("connection refused"));
    render(<Queue />);
    expect((await screen.findByRole("alert")).textContent).toContain("connection refused");
  });
});

describe("CaseView", () => {
  it("reads the facts first, then runs the review and lights the graph from the events", async () => {
    vi.mocked(api.fetchEvidence).mockResolvedValue(EVIDENCE);
    vi.mocked(api.fetchTrace).mockResolvedValue(TRACE);
    vi.mocked(api.fetchRecord).mockResolvedValue(RECORD);
    vi.mocked(api.fetchEvents).mockResolvedValue({ run_id: "r", finished: true, events: EVENTS });
    vi.mocked(api.startReview).mockResolvedValue(ANSWER);
    let push: (e: (typeof EVENTS)[number]) => void = () => undefined;
    vi.mocked(api.followRun).mockImplementation((_id, onEvent) => {
      push = onEvent;
      return () => undefined;
    });

    render(<CaseView alertId="ALR-0001" />);
    expect(await screen.findByText("Evidence")).toBeTruthy();
    expect(screen.queryByText("Review steps")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review this alert" }));
    await waitFor(() => expect(api.followRun).toHaveBeenCalled());
    push(EVENTS[1] as (typeof EVENTS)[number]);
    await waitFor(() => expect(screen.getAllByText("Review steps").length).toBeGreaterThan(0));

    expect(await screen.findByTestId("verdict")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review again" })).toBeTruthy();
    expect(screen.getByText("Replay")).toBeTruthy();
    expect(screen.getByText("Decision trace")).toBeTruthy();
    expect(screen.getByText("Model routing and cost")).toBeTruthy();
    expect(api.startReview).toHaveBeenCalledWith("ALR-0001", expect.stringMatching(/^ui-ALR-0001-/));
  });

  it("shows the problem when the review cannot start", async () => {
    vi.mocked(api.fetchEvidence).mockResolvedValue(EVIDENCE);
    vi.mocked(api.fetchTrace).mockRejectedValue(new Error("none"));
    vi.mocked(api.fetchRecord).mockRejectedValue(new Error("none"));
    vi.mocked(api.followRun).mockReturnValue(() => undefined);
    vi.mocked(api.startReview).mockRejectedValue(new Error("alert ALR-0001 is already being reviewed"));
    render(<CaseView alertId="ALR-0001" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review this alert" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already being reviewed");
  });
});

describe("ExamDashboard", () => {
  const exam: ExamAnswer = {
    label: "x",
    cases: 65,
    policy_version: 1,
    results: [
      {
        file: "a-routed.json",
        variant: "routed",
        started_at: "t",
        metrics: {
          cases: 65,
          errors: 0,
          exact_accuracy: 0.9,
          acceptable_accuracy: 0.97,
          risk_cases: 37,
          false_closes: 0,
          false_close_rate: 0,
          by_group: { false_positive: { cases: 15, exact: 13, acceptable: 15 } },
          latency_s: { mean: 40, p50: 38, p95: 90 },
          model_calls: { local: 100, cloud: 60, cloud_share: 0.375 },
          cost: { total: 1.25, per_case: 0.02 },
          tokens: { in: 1, out: 1 },
        },
      },
    ],
  };

  it("compares the saved variants, with false closes and the caveat about single runs", async () => {
    vi.mocked(api.fetchExam).mockResolvedValue(exam);
    render(<ExamDashboard />);
    expect((await screen.findAllByText("routed")).length).toBeGreaterThan(0);
    expect(screen.getByText("0 of 37 risk cases")).toBeTruthy();
    expect(screen.getByText("15/15")).toBeTruthy();
    expect(screen.getByText(/one run/)).toBeTruthy();
  });

  it("explains what to run when nothing is saved, and reports a read problem", async () => {
    vi.mocked(api.fetchExam).mockResolvedValue({ ...exam, results: [] });
    render(<ExamDashboard />);
    expect(await screen.findByText(/no results have been saved yet/)).toBeTruthy();
    cleanup();
    vi.mocked(api.fetchExam).mockRejectedValue(new Error("down"));
    render(<ExamDashboard />);
    expect((await screen.findByRole("alert")).textContent).toContain("down");
  });
});

describe("styles", () => {
  const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
  it("stops the working-step animation when the visitor prefers reduced motion", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });
  it("has a dark theme", () => {
    expect(css).toContain("prefers-color-scheme: dark");
  });
});

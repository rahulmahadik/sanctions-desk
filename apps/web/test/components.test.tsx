// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "../components/DecisionPanel";
import { EvidenceCards } from "../components/Evidence";
import { ExamDashboard } from "../components/ExamDashboard";
import { Governance } from "../components/Governance";
import { HeadlineStrip } from "../components/HeadlineStrip";
import { ListChangePanel } from "../components/ListChange";
import { Queue } from "../components/Queue";
import { Outcome, Replay } from "../components/Record";
import { RoutingPanel } from "../components/Routing";
import { RunGraph, stoppedSteps } from "../components/RunGraph";
import { parseSpan, SignalsPanel, signalStatus } from "../components/Signals";
import { UserSwitcher } from "../components/UserSwitcher";
import { graphAt } from "../lib/graph";
import type { ExamAnswer, QueueAlert, TraceView } from "../lib/types";
import {
  ANSWER,
  EVENTS,
  EVIDENCE,
  ev,
  HUMAN,
  ME_ANALYST,
  ME_APPROVER,
  ME_VIEWER,
  RECORD,
  SPLIT,
  TRACE,
} from "./fixtures";

vi.mock("../lib/api", () => ({
  API_URL: "http://api.test",
  fetchQueue: vi.fn(),
  fetchExam: vi.fn(),
  fetchGovernance: vi.fn(),
  fetchEvidence: vi.fn(),
  fetchTrace: vi.fn(),
  fetchRecord: vi.fn(),
  fetchEvents: vi.fn(),
  startReview: vi.fn(),
  followRun: vi.fn(),
  fetchReceiptCheck: vi.fn(),
  fetchPolicy: vi.fn(),
  postListChange: vi.fn(),
  fetchMe: vi.fn(),
  downloadCaseFile: vi.fn(),
  fetchHuman: vi.fn(),
  postDecision: vi.fn(),
  postSecondApproval: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { CaseView } from "../components/CaseView";
import * as api from "../lib/api";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchExam).mockResolvedValue({ label: "x", cases: 70, results: [], policy_version: 1 });
  vi.mocked(api.fetchMe).mockResolvedValue(ME_VIEWER);
  vi.mocked(api.fetchHuman).mockRejectedValue(new api.ApiError("no recommendation yet", 404));
  vi.mocked(api.fetchPolicy).mockRejectedValue(new api.ApiError("not needed here", 404));
});

/** The safety guard's model call and verdict, then the rule step, as the trace logs them: all under policy_guard. */
const GUARD_EVENTS = [
  ev("system", "run_started"),
  ev("policy_guard", "model_answer", {
    model_used: "local-runtime/nemotron-3.5-lightning-30b-a3b",
    route_kind: "local",
    receipt: { receipt_id: "rcpt_guard_1" },
  }),
  ev("policy_guard", "screen_inbound", { output_summary: "no instruction-like text" }),
  ev("policy_guard", "apply_policy", { output_summary: "ESCALATE_L2 stands" }),
  ev("system", "run_completed"),
];

describe("RunGraph", () => {
  it("draws every step, the critic round count and where the models ran", () => {
    render(<RunGraph view={graphAt(EVENTS)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.getByTestId("node-decision").textContent).toContain("1 retry");
    expect(screen.getByTestId("node-decision").textContent).toContain("local");
    expect(screen.getByTestId("critic-rounds").textContent).toContain("2 of 3");
    expect(screen.getByTestId("critic-rounds").textContent).toContain("finished");
    // A step with no events in a finished run did not run; it is not still waiting.
    expect(screen.getByTestId("node-challenger").textContent).toContain("not run in this review");
  });

  it("shows a step that stopped a proposed close in red, with the reason on hover", () => {
    const stopped = stoppedSteps({
      stopped: true,
      by: ["policy guard"],
      reasons: ['jurisdiction: watched jurisdiction: IR (payment reference mentions "Tehran")'],
    });
    render(<RunGraph view={graphAt(EVENTS)} stopped={stopped} />);
    const guard = screen.getByTestId("node-policy_guard");
    expect(guard.getAttribute("data-blocked")).toBe("true");
    expect(guard.getAttribute("title")).toContain("Tehran");
    expect(guard.textContent).toContain("stopped a close");
    expect(screen.getByTestId("node-critic").getAttribute("data-blocked")).toBeNull();
    expect(stoppedSteps({ stopped: false, by: [], reasons: [] })).toEqual({});
  });

  it("marks the working step with a state the styles can show without motion", () => {
    render(<RunGraph view={graphAt(EVENTS, 4)} />);
    expect(screen.getByTestId("node-matching").getAttribute("data-state")).toBe("running");
  });

  it("puts the safety guard's model call on the Safety guard node and leaves the Policy guard as the rule step", () => {
    render(<RunGraph view={graphAt(GUARD_EVENTS)} />);
    const safety = screen.getByTestId("node-safety_guard");
    expect(safety.textContent).toContain("Safety guard");
    expect(safety.textContent).toContain("local Lightning 30B");
    expect(screen.getByTestId("receipt-link-safety_guard").textContent).toContain("rcpt_guard_1");
    const policy = screen.getByTestId("node-policy_guard");
    expect(policy.textContent).toContain("Policy guard");
    expect(policy.textContent).toContain("done");
    expect(policy.textContent).not.toContain("routed");
  });
});

describe("RunGraph, model per step", () => {
  const MODEL_EVENTS = [
    ev("system", "run_started"),
    ev("policy_guard", "model_answer", {
      provider: "nightshift",
      model_used: "local-runtime/nemotron-3.5-lightning-30b-a3b",
      route_kind: "local",
      receipt: { receipt_id: "rcpt_guard_2", verification: "valid_pinned" },
    }),
    ev("decision", "model_answer", {
      provider: "nightshift",
      model_used: "nvidia/nemotron-3-ultra-550b-a55b",
      route_kind: "cloud",
      receipt: { receipt_id: "rcpt_dec_1", verification: "valid_unpinned" },
    }),
    ev("critic", "model_answer", {
      provider: "ollama",
      model_used: "nemotron-3.5-lightning:30b",
      route_kind: "local",
    }),
    ev("system", "run_completed"),
  ];

  it("shows, for every model step, the model that answered and the receipt check", () => {
    render(<RunGraph view={graphAt(MODEL_EVENTS)} />);
    expect(screen.getByTestId("model-chip-safety_guard").textContent).toContain("local Lightning 30B");
    expect(screen.getByTestId("receipt-check-safety_guard").textContent).toBe("signature valid, key pinned");
    expect(screen.getByTestId("model-chip-decision").textContent).toContain("cloud Ultra 550B");
    expect(screen.getByTestId("receipt-link-decision").textContent).toContain("rcpt_dec_1");
    expect(screen.getByTestId("receipt-check-decision").textContent).toBe("signature valid, key from the receipt");
    expect(screen.getByTestId("model-chip-critic").textContent).toContain("backup local Lightning 30B");
    expect(screen.queryByTestId("receipt-link-critic")).toBeNull();
    expect(screen.getByTestId("receipt-check-critic").textContent).toContain("Ollama backup");
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
    const row = screen.getByText(/Nemotron 3 Ultra 550B/, { selector: "td" }).closest("tr");
    expect(row?.textContent).toContain("nvidia/nemotron-3-ultra-550b-a55b");
    expect(row?.textContent).toContain("sanctions-desk-reasoning");
    expect(row?.textContent).toContain("cloud");
    expect(row?.textContent).toContain("valid pinned");
    expect(row?.textContent).toContain("0.02 USD");
    expect(row?.textContent).toContain("budget 500 tokens");
    expect(screen.getByText(/Unit costs are assumptions/)).toBeTruthy();
  });

  it("shows the measured split of calls by serving model, and says the router decides", () => {
    render(<RoutingPanel trace={TRACE} split={SPLIT} />);
    const table = screen.getByTestId("routing-split");
    const rows = within(table).getAllByRole("row");
    expect(rows[0]?.textContent).toContain("Nemotron 3 Ultra 550B (cloud)");
    expect(rows[0]?.textContent).toContain("Nemotron 3.5 Lightning 30B (local)");
    const safety = rows.find((r) => r.textContent?.startsWith("Safety guard"));
    expect(safety?.textContent).toContain("100.0% (48)");
    const critic = rows.find((r) => r.textContent?.startsWith("Critic"));
    expect(critic?.textContent).toContain("95.6% (65)");
    expect(critic?.textContent).toContain("4.4% (3)");
    expect(screen.getByText(/learned router/)).toBeTruthy();
    expect(screen.getByText(/do not route by difficulty and do not pin the cloud/)).toBeTruthy();
  });

  it("puts the requested model, the routed model and the receipt id side by side", () => {
    render(<RoutingPanel trace={TRACE} />);
    const row = screen.getByTestId("receipt-id").closest("tr");
    const cells = [...(row?.querySelectorAll("td") ?? [])].map((c) => c.textContent ?? "");
    expect(cells[1]).toBe("meterless/deep");
    expect(cells[2]).toContain("nvidia/nemotron-3-ultra-550b-a55b");
    expect(cells[3]).toBe("rcpt_test_1");
  });

  it("shows both models when the signed receipt names another model than the trace", async () => {
    const check = {
      receipt_id: "rcpt_test_1",
      status: "valid_unpinned" as const,
      body_hash: "a".repeat(64),
      signer_public_key: null,
      key_pinned: false,
      app: "sanctions-desk-reasoning",
      requested_mode: "deep",
      routed_mode: "deep",
      mode_coerced: false,
      route_kind: "local",
    };
    vi.mocked(api.fetchReceiptCheck).mockResolvedValue({ ...check, served_by: "local-runtime/other-model" });
    render(<RoutingPanel trace={TRACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt rcpt_test_1" }));
    const differs = await screen.findByTestId("receipt-differs-rcpt_test_1");
    expect(differs.textContent).toContain("local-runtime/other-model");
    expect(differs.textContent).toContain("nvidia/nemotron-3-ultra-550b-a55b");

    cleanup();
    vi.mocked(api.fetchReceiptCheck).mockResolvedValue({ ...check, served_by: "nvidia/nemotron-3-ultra-550b-a55b" });
    render(<RoutingPanel trace={TRACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt rcpt_test_1" }));
    await screen.findByTestId("receipt-rcpt_test_1");
    expect(screen.queryByTestId("receipt-differs-rcpt_test_1")).toBeNull();
  });

  it("leaves the split out when the exam has not been run", () => {
    render(<RoutingPanel trace={TRACE} split={null} />);
    expect(screen.queryByTestId("routing-split")).toBeNull();
  });

  it("says so when no model was called", () => {
    render(<RoutingPanel trace={{ ...TRACE, cost: { ...TRACE.cost, models: [] } }} />);
    expect(screen.getByText(/No model was called/)).toBeTruthy();
  });

  it("names a model call logged under the policy guard as the safety guard's", () => {
    const first = TRACE.cost.models[0] as TraceView["cost"]["models"][number];
    const guard = { ...first, agent: "policy_guard", model_requested: "meterless/fast", receipt_id: "rcpt_guard_1" };
    render(<RoutingPanel trace={{ ...TRACE, cost: { ...TRACE.cost, models: [guard, first] } }} />);
    const steps = screen.getAllByRole("row").map((r) => r.querySelector("td")?.textContent);
    expect(steps).toContain("safety guard");
    expect(steps).not.toContain("policy guard");
  });
});

describe("ListChangePanel", () => {
  it("lists earlier decisions whose entry changed, with the snapshot then and now and the open alerts, and changes nothing", async () => {
    vi.mocked(api.postListChange).mockResolvedValue({
      total: 13,
      examined: 13,
      complete: true,
      unchanged: 7,
      policy_version: 8,
      trace_id: "replay-1",
      impact: { customers: 1, pending_payments: 1, summary: "affects 1 customer and 1 pending payment" },
      release: [],
      reopen: [
        {
          disposition_id: "DSP-0007",
          customer_id: "CUS-1",
          entry_id: "OFAC-30969",
          entry_name: "Yiu-chung Tam",
          earlier_decision: "CLOSE_FALSE_POSITIVE",
          reason_code: "ENTRY_CHANGED",
          earlier_hash: "a",
          current_hash: "b",
          earlier_snapshot_id: "ofac-then",
          current_snapshot_id: "ofac-now",
          open_alert_ids: ["ALR-0058"],
        },
      ],
    });
    render(<ListChangePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Check earlier decisions/ }));
    const table = await screen.findByTestId("list-change");
    expect(table.textContent).toContain("ofac-then");
    expect(table.textContent).toContain("ofac-now");
    expect(within(table).getByText("ALR-0058").getAttribute("href")).toBe("/case/ALR-0058");
    expect(screen.getByTestId("list-change-summary").textContent).toContain("Nothing has been reopened or released");
  });

  it("says so when every listed entry is as it was, and when there is nothing to check yet", async () => {
    const unchanged = {
      total: 13,
      examined: 13,
      complete: true,
      unchanged: 13,
      policy_version: 8,
      trace_id: "replay-2",
      impact: { customers: 0, pending_payments: 0, summary: "affects 0 customers and 0 pending payments" },
      release: [],
      reopen: [],
    };
    vi.mocked(api.postListChange).mockResolvedValue(unchanged);
    render(<ListChangePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Check earlier decisions/ }));
    expect((await screen.findByTestId("list-change-empty")).textContent).toContain("every listed entry is as it was");
    expect(screen.queryByTestId("list-change")).toBeNull();
    cleanup();
    vi.mocked(api.postListChange).mockResolvedValue({ ...unchanged, total: 0, examined: 0, unchanged: 0 });
    render(<ListChangePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Check earlier decisions/ }));
    expect((await screen.findByTestId("list-change-empty")).textContent).toContain("no earlier decisions to check yet");
  });
});

describe("SignalsPanel", () => {
  const T = { normal: 0.5, other: 0.7 };
  const evidence = {
    ...EVIDENCE,
    customer: { ...EVIDENCE.customer, notes: "Customer is the son of Ivan Petrov, per KYC call." },
  };
  it("shows each signal's source field and the exact text span it points at", () => {
    render(
      <SignalsPanel
        screener={{
          status: "ok",
          fields_read: ["customer.notes"],
          signals: [
            {
              type: "relationship_to_listed_party",
              confidence: 0.9,
              span_id: "customer.notes:16-34",
              span_valid: true,
              grounded: true,
            },
          ],
        }}
        evidence={evidence}
        thresholds={T}
      />,
    );
    expect(screen.getByTestId("signal").textContent).toContain("customer.notes");
    expect(screen.getByTestId("signal-span").textContent).toBe("son of Ivan Petrov");
    expect(screen.getByTestId("signal-status").textContent).toContain("blocks a close");
  });

  it("labels a signal that is not grounded and still shows it", () => {
    render(
      <SignalsPanel
        screener={{
          status: "ok",
          fields_read: ["customer.notes"],
          signals: [
            {
              type: "relationship_to_listed_party",
              confidence: 0.9,
              span_id: "customer.notes:0-8",
              span_valid: true,
              grounded: false,
              grounding_reason: "no relation term in the span",
            },
            {
              type: "alias_or_former_name",
              confidence: 0.5,
              span_id: "customer.notes:unlocated",
              span_valid: false,
              grounded: false,
            },
          ],
        }}
        evidence={evidence}
        thresholds={T}
      />,
    );
    const statuses = screen.getAllByTestId("signal-status").map((s) => s.textContent?.replace(/^!/, ""));
    expect(statuses).toEqual([
      "not grounded: shown for review, still blocks a close",
      "not grounded: shown for review, still blocks a close",
    ]);
    expect(screen.getAllByTestId("signal")[1]?.textContent).toContain("no location in the text");
  });

  it("says when a signal is below its threshold, and reads span ids", () => {
    expect(
      signalStatus({ type: "other", confidence: 0.5, span_id: "x:1-2", span_valid: true, grounded: false }, T),
    ).toContain("does not block");
    expect(
      signalStatus({ type: "other", confidence: 0.5, span_id: "x:1-2", span_valid: true, grounded: false }, undefined),
    ).toBe("not grounded: shown for review, still blocks a close");
    expect(parseSpan("payment.payment_reference:3-9")).toEqual({
      field: "payment.payment_reference",
      start: 3,
      end: 9,
    });
    expect(parseSpan("customer.notes:unlocated")).toEqual({ field: "customer.notes" });
  });
});

describe("Outcome", () => {
  it("shows the recommendation, what would change it and that a person decides", () => {
    render(<Outcome answer={ANSWER} />);
    expect(screen.getByTestId("verdict").textContent).toBe("✓ Close as false positive");
    expect(screen.getByText(/A person decides/)).toBeTruthy();
    expect(screen.getByText("A matching identifier number")).toBeTruthy();
    expect(screen.getByText(/critic: approved after 2 rounds/)).toBeTruthy();
  });

  it("shows a screener signal that is not grounded, and a citation the critic set aside as not citable", () => {
    render(
      <Outcome
        answer={{
          ...ANSWER,
          guards: [
            {
              guard: "screener_grounding",
              verdict: "flag",
              detail:
                "1 signal(s) not grounded in the text they point at; shown for the reviewer; they still block a close",
            },
          ],
          critic: {
            rounds: 2,
            final_verdict: "approved",
            not_citable: [{ table: "customer", column: "notes", reason: "a free-text column", round: 2 }],
          },
        }}
      />,
    );
    expect(
      screen.getByText(/not grounded in the text they point at; shown for the reviewer; they still block a close/),
    ).toBeTruthy();
    expect(screen.getByTestId("not-citable").textContent).toContain("customer.notes as not citable (round 2)");
  });

  it("shows that the safety guard ran in the cloud and its answer was not accepted", () => {
    render(
      <Outcome
        answer={{
          ...ANSWER,
          decision: "ESCALATE_L2",
          guards: [
            {
              guard: "guard_locality",
              verdict: "block",
              detail:
                "guard ran in the cloud: the free text left the machine and the guard's answer is not accepted; no close",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/safety guard ran on this machine: stopped it — guard ran in the cloud/)).toBeTruthy();
  });

  it("puts the deciding evidence and any confidence cap with its reason right under the recommendation", () => {
    render(
      <Outcome
        answer={{ ...ANSWER, confidence: 0.6, confidence_cap: { value: 0.6, reason: "a data-quality rule fails" } }}
      />,
    );
    expect(screen.getByTestId("confidence").textContent).toContain(
      "Confidence 60% (capped at 60%: a data-quality rule fails)",
    );
    const lines = within(screen.getByTestId("key-evidence")).getAllByRole("listitem");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.textContent).toBe("Comparison: name 1.00 (exact)");
    const heading = screen.getByText("What decided it");
    const rationale = screen.getByText(ANSWER.rationale ?? "");
    expect(heading.compareDocumentPosition(rationale) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no evidence heading when the review gave none", () => {
    render(<Outcome answer={{ ...ANSWER, key_evidence: [] }} />);
    expect(screen.queryByText("What decided it")).toBeNull();
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
    expect(screen.getByText(/against list snapshot .*does not re-run the case on an earlier list/)).toBeTruthy();
    const slider = screen.getByLabelText(/Event 12 of 12/);
    fireEvent.change(slider, { target: { value: "4" } });
    expect(screen.getByTestId("node-matching").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("replay-current").textContent).toContain("matching");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(screen.getByTestId("replay-current").textContent).toBe("Before the run started");
  });

  it("names the safety guard's events as such in the event list and the line shown, and the rule step as the policy guard", () => {
    render(<Replay events={GUARD_EVENTS} />);
    const list = screen.getByLabelText("Recorded events").textContent ?? "";
    expect(list).toContain("safety_guard/model_answer");
    expect(list).toContain("safety_guard/screen_inbound");
    expect(list).toContain("policy_guard/apply_policy");
    fireEvent.change(screen.getByLabelText(/Event 5 of 5/), { target: { value: "3" } });
    expect(screen.getByTestId("replay-current").textContent).toContain("safety guard · screen inbound");
    fireEvent.change(screen.getByLabelText(/Event 3 of 5/), { target: { value: "4" } });
    expect(screen.getByTestId("replay-current").textContent).toContain("policy guard · apply policy");
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
    expect(screen.getByText(/^1 of 2 alerts, most severe first/)).toBeTruthy();
  });

  it("says plainly when the queue cannot be read", async () => {
    vi.mocked(api.fetchQueue).mockRejectedValue(new Error("connection refused"));
    render(<Queue />);
    expect((await screen.findByRole("alert")).textContent).toContain("connection refused");
  });

  it("says when the queue is empty, and when no alert matches the filter", async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue({ alerts: [], sample_mode: true });
    render(<Queue />);
    expect((await screen.findByText(/The queue is empty/)).textContent).toContain("no alerts to review");
    cleanup();
    vi.mocked(api.fetchQueue).mockResolvedValue({ alerts: ALERTS, sample_mode: true });
    render(<Queue />);
    await screen.findByText("ALR-0001");
    fireEvent.change(screen.getByLabelText(/Show/), { target: { value: "reviewed" } });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "customer" } });
    expect(screen.getByText("No alerts match this filter.")).toBeTruthy();
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
    // The value comes first: the recommendation sits above the steps and the trace.
    const verdict = screen.getByTestId("verdict");
    const trace = screen.getByText("Decision trace");
    expect(verdict.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("What decided it")).toBeTruthy();
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

  it("says it is reading the facts until they arrive, reports a failed trace read, and stays quiet about a missing record", async () => {
    let giveEvidence: (v: typeof EVIDENCE) => void = () => undefined;
    vi.mocked(api.fetchEvidence).mockReturnValue(
      new Promise((resolve) => {
        giveEvidence = resolve;
      }),
    );
    vi.mocked(api.fetchTrace).mockRejectedValue(new Error("the API answered HTTP 500"));
    vi.mocked(api.fetchRecord).mockRejectedValue(new api.ApiError("no recommendation yet", 404));
    render(<CaseView alertId="ALR-0001" />);
    expect(screen.getByText("Reading the case facts…")).toBeTruthy();
    giveEvidence(EVIDENCE);
    expect(await screen.findByText("Evidence")).toBeTruthy();
    expect(screen.queryByText("Reading the case facts…")).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("HTTP 500");
    expect(alert.textContent).not.toContain("no recommendation yet");
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

  it("keeps held-out and later-version runs out of the 70-case table, and shows every held-out round with its baselines", async () => {
    const first = exam.results[0] as ExamAnswer["results"][number];
    const cell = (wrong: number, text: string) => ({
      file: "f",
      risk: 6,
      wrong_closes: wrong,
      wrong_close_ids: [],
      clears: 6,
      clears_made: 0,
      text,
    });
    vi.mocked(api.fetchExam).mockResolvedValue({
      ...exam,
      results: [
        { ...first, file: "b.json", exam: "heldout4", metrics: { ...first.metrics, risk_cases: 6, false_closes: 3 } },
        first,
      ],
      heldout_rounds: [
        {
          id: "v4",
          label: "Held-out v4 (12 cases, last round)",
          system: "fails closed",
          commit: "80902ea",
          blind: true,
          cells: {
            routed: cell(0, "0 of 6 risks closed; 0 of 6 clears"),
            single: null,
            rules: cell(3, "3 of 6 risks closed (HO4-002); 2 of 6 clears"),
            fuzzy: null,
            escalate_all: cell(0, "0 of 6 risks closed; 0 of 6 clears"),
          },
        },
      ],
    });
    render(<ExamDashboard />);
    const rounds = await screen.findByTestId("heldout-rounds");
    const row = within(rounds).getByText("Held-out v4 (12 cases, last round)").closest("tr");
    const cells = [...(row?.querySelectorAll("td") ?? [])].map((c) => c.textContent);
    expect(cells.slice(1)).toEqual([
      "0 of 6 risks closed; 0 of 6 clears",
      "not part of this round",
      "3 of 6 risks closed (HO4-002); 2 of 6 clears",
      "not part of this round",
      "0 of 6 risks closed; 0 of 6 clears",
    ]);
    // The 70-case table shows the exam run only.
    expect(screen.getByText("0 of 37 risk cases")).toBeTruthy();
    expect(screen.queryByText("3 of 6 risk cases")).toBeNull();
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

describe("HeadlineStrip", () => {
  const exam: ExamAnswer = {
    label: "x",
    cases: 70,
    policy_version: 1,
    results: [],
    headline: {
      alerts: 68,
      closed_with_evidence: 20,
      closed_correctly: 20,
      escalated: 48,
      closed_share: 0.29,
      escalated_share: 0.71,
      risk_cases: 42,
      false_closes: 0,
      false_close_rate: 0,
      true_match_cases: 8,
      true_match_false_closes: 0,
      decision_unavailable: 0,
      minutes_saved_per_100_alerts: 382,
      assumptions: { minutesPerAlert: 15, minutesToConfirmClose: 2 },
    },
    headline_sentence:
      "0 of 42 risk cases wrongly closed; 29% of alerts recommended for closing with cited evidence and 71% escalated, each for a person to decide.",
  };

  it("shows the measured headline of the 70-case exam", async () => {
    vi.mocked(api.fetchExam).mockResolvedValue(exam);
    render(<HeadlineStrip />);
    expect((await screen.findByTestId("headline-strip")).textContent).toContain("70-case exam (first system, one run)");
    expect(screen.getByTestId("headline-strip").textContent).toContain("0 of 42 risk cases wrongly closed");
  });

  it("shows the headline run's time per alert as the README does, and no other run's median", async () => {
    const perAlert = {
      alerts: 68,
      median_seconds: 129.67,
      mean_seconds: 140,
      p95_seconds: 306,
      mean_cost: 0.0085,
      manual_seconds: null,
      times_faster: null,
      note: "",
    };
    vi.mocked(api.fetchExam).mockResolvedValue({
      ...exam,
      headline: { ...exam.headline, per_alert: perAlert } as ExamAnswer["headline"],
      current_run: {
        name: "heldout4-sys4-routed",
        system: "sys4",
        exam: "heldout4",
        started_at: "2026-10-24T02:45:23.713Z",
        alerts: 12,
        median_seconds: 45.4,
      },
    });
    render(<HeadlineStrip />);
    const text = (await screen.findByTestId("headline-strip")).textContent ?? "";
    expect(text).toContain("a median of 130 seconds per alert over the 68 alerts of the recorded 70-case run");
    expect(text).not.toContain("45 seconds");
    expect(text.match(/median/g)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "All results" }).getAttribute("href")).toBe(
      "https://rahulmahadik.github.io/sanctions-desk/results.html",
    );
  });

  it("says so, and invents nothing, when there is no complete run or the results cannot be read", async () => {
    vi.mocked(api.fetchExam).mockResolvedValue({ ...exam, headline: null, headline_sentence: null });
    render(<HeadlineStrip />);
    expect((await screen.findByTestId("headline-strip")).textContent).toContain("No complete exam run is saved yet");
    cleanup();
    vi.mocked(api.fetchExam).mockRejectedValue(new Error("down"));
    render(<HeadlineStrip />);
    expect((await screen.findByTestId("headline-strip")).textContent).toContain("No complete exam run");
  });
});

describe("Governance", () => {
  const view = {
    mapping_note: "This is a mapping, not a claim of compliance.",
    inventory: {
      name: "sanctions-desk",
      purpose: "Recommends an outcome.",
      status: "prototype",
      deployment: "local",
      data: "synthetic",
      models: [{ name: "Nemotron 3 Ultra 550B", served: "cloud", used_by: ["decision"] }],
      which_model_serves: "Nightshift's learned router decides",
      components: ["Zetaris"],
      policy_version: 1,
      sample_mode: true,
    },
    risk_materiality: {
      kind: "self-assessment",
      dimensions: [{ dimension: "impact", rating: "high", basis: "a breach" }],
      conclusion: "material",
    },
    human_oversight: {
      hard_limits: { auto_block: false, approvals_required_for_a_block: 2 },
      controls: ["A person decides."],
    },
    explainability: { record: "A sealed record.", evidence: "Re-read by code.", where: ["GET /cases/:id/trace"] },
    testing: {
      exam_report: "eval/REPORT.md",
      headline: null,
      headline_sentence: null,
      headline_run: null,
      baselines: "compared with baselines",
      label_changes: [{ case_id: "EX-008", reason: "r" }],
      limits: "one run",
    },
    monitoring: {
      model_ledger: "every call is logged",
      routing_split: SPLIT,
      json_failure_rate: null,
      provider_failures: "counted by mode",
      access: "checked at start",
    },
    change_control: {
      active_policy_version: 1,
      policy_versions: [
        { version: 1, status: "active", proposed_by: "system", approved_by: "system", published_at: null },
      ],
      audit_entries: 1,
      rule: "Four-eyes.",
      code: "version control",
    },
    limits: ["Synthetic data only."],
  };

  it("shows the mapping note first and every section, and says when there is no exam run", async () => {
    vi.mocked(api.fetchGovernance).mockResolvedValue(view as never);
    render(<Governance />);
    expect((await screen.findByTestId("mapping-note")).textContent).toContain("not a claim of compliance");
    for (const heading of [
      "AI inventory entry",
      "Risk materiality",
      "Human oversight",
      "Explainability",
      "Testing",
      "Monitoring",
      "Change control",
      "Limits",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }
    expect(screen.getByText("No complete exam run is saved yet.")).toBeTruthy();
    expect(screen.getByText(/Labels changed after the first full run: EX-008/)).toBeTruthy();
    expect(screen.getByTestId("routing-split")).toBeTruthy();
  });

  it("reports a read problem", async () => {
    vi.mocked(api.fetchGovernance).mockRejectedValue(new Error("down"));
    render(<Governance />);
    expect((await screen.findByRole("alert")).textContent).toContain("down");
  });

  it("says when no policy version is recorded", async () => {
    vi.mocked(api.fetchGovernance).mockResolvedValue({
      ...view,
      change_control: { ...view.change_control, policy_versions: [] },
    } as never);
    render(<Governance />);
    expect(await screen.findByText("No policy versions are recorded.")).toBeTruthy();
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
  it("keeps controls and long words inside the page at phone width, and scrolls wide tables in their own box", () => {
    expect(css).toMatch(/input,\s*select,\s*textarea\s*\{[^}]*max-width: 100%/);
    expect(css).toMatch(/\.reason-input\s*\{[^}]*width: 100%;[^}]*max-width: 320px/);
    expect(css).toMatch(/\.user-switcher\s*\{[^}]*max-width: 100%/);
    expect(css).toMatch(/\.node\s*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/code,\s*\.events\s*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.table-wrap\s*\{[^}]*overflow-x: auto/);
  });
});

describe("UserSwitcher", () => {
  it("offers the labelled demo users in sample mode", async () => {
    render(<UserSwitcher />);
    const select = await screen.findByLabelText("Demo user (sample mode only)");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Visitor (read only)",
      "analyst_demo — Analyst (L1)",
      "approver_demo — Approver (L2 senior reviewer)",
      "approver2_demo — Approver (L2 senior reviewer)",
      "admin_demo — Policy admin",
    ]);
    expect(screen.getByText("Demo user")).toBeTruthy();
  });

  it("shows who is signed in, with no demo choice, when the deployment has sign-in on", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue({
      ...ME_ANALYST,
      auth: "on",
      demo_users: [],
      user: { id: "ann", role: "analyst", demo: false },
    });
    render(<UserSwitcher />);
    expect((await screen.findByText("ann")).textContent).toBe("ann");
    expect(screen.queryByLabelText("Demo user (sample mode only)")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});

describe("DecisionPanel", () => {
  it("asks for a review first when there is no recommendation", async () => {
    render(<DecisionPanel alertId="ALR-0001" />);
    expect((await screen.findByText(/no recommendation yet/i)).textContent).toContain("Review the alert first");
  });

  it("will not let a visitor decide, and says what to do", async () => {
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.awaiting);
    render(<DecisionPanel alertId="ALR-0001" />);
    expect(await screen.findByText(/Choose a demo user/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Decide" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pre-selects nothing: neither approve nor override is chosen until the person picks one", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.awaiting);
    render(<DecisionPanel alertId="ALR-0001" />);
    const radios = (await screen.findAllByRole("radio")) as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Dates of birth differ by 14 years." } });
    expect((screen.getByRole("button", { name: "Decide" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose approve or override.")).toBeTruthy();
  });

  it("needs a reason before an analyst can approve, then sends the decision with the record hash", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.awaiting);
    vi.mocked(api.postDecision).mockResolvedValue(HUMAN.decided);
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Approve the recommendation/ }));
    const button = (await screen.findByRole("button", { name: "Approve" })) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/at least 10 characters/)).toBeTruthy());
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Dates of birth differ by 14 years." } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.postDecision).toHaveBeenCalledWith("ALR-0001", {
        action: "approve",
        reason: "Dates of birth differ by 14 years.",
        record_hash: HUMAN.awaiting.record_hash,
      }),
    );
    expect(await screen.findByText(/Decided by a person/)).toBeTruthy();
    expect(screen.getByText("Closure note")).toBeTruthy();
    expect(screen.getByText(/hash-sealed/)).toBeTruthy();
    // The person who decided is shown with the role name people read, not the role id.
    expect(screen.getByText("Analyst (L1)")).toBeTruthy();
    expect(screen.queryByText(/\(analyst\)/)).toBeNull();
  });

  it("names the role that cannot decide as people read it", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue({
      ...ME_VIEWER,
      user: { id: "admin_demo", role: "policy_admin", demo: true },
    });
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.awaiting);
    render(<DecisionPanel alertId="ALR-0001" />);
    expect(await screen.findByText("The Policy admin role cannot record decisions.")).toBeTruthy();
  });

  it("stops an analyst from overriding towards a less cautious outcome", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    vi.mocked(api.fetchHuman).mockResolvedValue({
      ...HUMAN.awaiting,
      recommendation: { decision: "ESCALATE_L2", confidence: 0.8, rationale: "x" },
    });
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.click(await screen.findByLabelText(/Override with/));
    fireEvent.change(screen.getByLabelText("Outcome for an override"), { target: { value: "CLOSE_FALSE_POSITIVE" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A long enough reason to submit." } });
    expect(screen.getByText(/Only an approver can override towards a less cautious outcome/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Override" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a block as pending, and only a different approver can give the second approval", async () => {
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.blockPending);
    vi.mocked(api.fetchMe).mockResolvedValue({
      ...ME_APPROVER,
      user: { id: "analyst_demo", role: "approver", demo: true },
    });
    const { unmount } = render(<DecisionPanel alertId="ALR-0001" />);
    expect(await screen.findByText(/Block approval pending/)).toBeTruthy();
    expect(screen.getByText("block approval pending")).toBeTruthy();
    expect(await screen.findByText(/You made the first decision; a different approver must confirm/)).toBeTruthy();
    unmount();

    vi.mocked(api.fetchMe).mockResolvedValue(ME_APPROVER);
    vi.mocked(api.postSecondApproval).mockResolvedValue(HUMAN.blockApproved);
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Confirmed after reading the evidence." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Give the second approval" }));
    await waitFor(() => expect(api.postSecondApproval).toHaveBeenCalled());
    expect(await screen.findByText("Block recommendation for the sanctions officer")).toBeTruthy();
  });

  it("shows the API's refusal as an alert and keeps the form", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.awaiting);
    vi.mocked(api.postDecision).mockRejectedValue(new Error("the recommendation changed since you looked at it"));
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "A long enough reason to submit." } });
    fireEvent.click(screen.getByRole("radio", { name: /Approve the recommendation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed since you looked");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});

describe("a date of birth from a verified note", () => {
  it("is shown as coming from the note, with its check reference, and never as a value of the customer record", () => {
    render(
      <EvidenceCards
        view={EVIDENCE}
        documentary={[
          {
            field: "date_of_birth",
            value: "1975-03-02",
            source: "customer.notes",
            check_reference: "KYC-482113",
            label: "date of birth from verified note (check ref KYC-482113)",
          },
        ]}
      />,
    );
    const note = screen.getByTestId("documentary");
    expect(note.textContent).toContain("Not a value of the customer record");
    expect(note.textContent).toContain("date of birth from verified note (check ref KYC-482113)");
    expect(note.textContent).toContain("1975-03-02");
    expect(note.textContent).toContain("data-quality finding below stays");
  });

  it("is absent when there is no verified note", () => {
    render(<EvidenceCards view={EVIDENCE} />);
    expect(screen.queryByTestId("documentary")).toBeNull();
  });
});

describe("Verify receipt", () => {
  it("checks the signed receipt through the API and says which model served the call and under which app", async () => {
    vi.mocked(api.fetchReceiptCheck).mockResolvedValue({
      receipt_id: "rcpt_test_1",
      status: "valid_pinned",
      body_hash: "c".repeat(64),
      signer_public_key: "k",
      key_pinned: true,
      app: "sanctions-desk-reasoning",
      requested_mode: "deep",
      routed_mode: "auto",
      mode_coerced: true,
      served_by: "nvidia/nemotron-3-ultra-550b-a55b",
      route_kind: "cloud",
    });
    render(<RoutingPanel trace={TRACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt rcpt_test_1" }));
    const result = await screen.findByTestId("receipt-rcpt_test_1");
    expect(api.fetchReceiptCheck).toHaveBeenCalledWith("rcpt_test_1");
    expect(result.textContent).toContain("Verified");
    expect(result.textContent).toContain("signing key is the one pinned");
    expect(result.textContent).toContain("Served by Nemotron 3 Ultra 550B (cloud) for app sanctions-desk-reasoning");
    expect(result.textContent).toContain("the cockpit's bind replaced the request");
  });

  it("says plainly when a receipt does not verify, and when the check itself fails", async () => {
    vi.mocked(api.fetchReceiptCheck).mockResolvedValueOnce({
      receipt_id: "rcpt_test_1",
      status: "invalid",
      body_hash: null,
      signer_public_key: null,
      key_pinned: false,
      app: null,
      requested_mode: null,
      routed_mode: null,
      mode_coerced: null,
      served_by: null,
      route_kind: null,
    });
    render(<RoutingPanel trace={TRACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt rcpt_test_1" }));
    expect((await screen.findByTestId("receipt-rcpt_test_1")).textContent).toContain("Not verified");
    vi.mocked(api.fetchReceiptCheck).mockRejectedValueOnce(new Error("no stored receipt rcpt_test_1"));
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt rcpt_test_1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no stored receipt");
  });
});

describe("Verify all receipts", () => {
  it("checks every receipt of the recommendation and counts the Nemotron ones", async () => {
    vi.mocked(api.fetchReceiptCheck).mockResolvedValue({
      receipt_id: "rcpt_test_1",
      status: "valid_pinned",
      body_hash: "c".repeat(64),
      signer_public_key: "k",
      key_pinned: true,
      app: "sanctions-desk-reasoning",
      requested_mode: "deep",
      routed_mode: "auto",
      mode_coerced: true,
      served_by: "nvidia/nemotron-3-ultra-550b-a55b",
      route_kind: "cloud",
    });
    render(<RoutingPanel trace={TRACE} />);
    fireEvent.click(screen.getByRole("button", { name: /^Verify all \d+ receipts$/ }));
    const result = await screen.findByTestId("verify-all");
    expect(result.textContent).toMatch(/\d+ of \d+ signatures valid/);
    expect(result.textContent).toMatch(/\d+ of \d+ name a Nemotron model/);
  });
});

describe("the case file download", () => {
  it("offers the case file as PDF and Markdown once there is a recommendation", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.decided);
    vi.mocked(api.downloadCaseFile).mockResolvedValue();
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.click(await screen.findByRole("button", { name: "Download case file (PDF)" }));
    fireEvent.click(screen.getByRole("button", { name: "Download case file (Markdown)" }));
    await waitFor(() => expect(api.downloadCaseFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.downloadCaseFile).mock.calls).toEqual([
      ["ALR-0001", "pdf"],
      ["ALR-0001", "md"],
    ]);
  });

  it("shows why a download failed", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.decided);
    vi.mocked(api.downloadCaseFile).mockRejectedValue(new Error("alert ALR-0001 has no recommendation yet"));
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.click(await screen.findByRole("button", { name: "Download case file (PDF)" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no recommendation yet");
  });
});

describe("help and the first-run pointer", () => {
  it("renders each section heading, in the order of the user guide", async () => {
    const { Help, HELP_SECTIONS } = await import("../components/Help");
    render(<Help />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(HELP_SECTIONS.map((s) => s.title));
    expect(headings).toEqual([
      "Start it",
      "Choose a demo user",
      "The alert queue",
      "Open a case and review",
      "Read the result",
      "Decide",
      "What happens next",
      "Autonomy and the kill switch",
      "Change the policy",
      "Exam results and governance",
      "When something goes wrong",
    ]);
  });

  it("names the controls the screens really have", async () => {
    const { Help } = await import("../components/Help");
    render(<Help />);
    for (const word of [
      "analyst_demo",
      "approver_demo",
      "approver2_demo",
      "admin_demo",
      "Review this alert",
      "Verify receipt",
      "Verify all receipts",
      "Give the second approval",
      "Decline the block",
      "Download case file (PDF)",
      "Kill switch: force level 0 now",
      "Preview on the exam",
    ]) {
      expect(document.body.textContent).toContain(word);
    }
  });

  it("shows once, until it is dismissed, and remembers that in this browser", async () => {
    window.localStorage.removeItem("desk.tourSeen");
    const { FirstRun } = await import("../components/FirstRun");
    const first = render(<FirstRun />);
    expect(await screen.findByTestId("first-run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(window.localStorage.getItem("desk.tourSeen")).toBe("yes");
    first.unmount();
    render(<FirstRun />);
    await waitFor(() => expect(screen.queryByTestId("first-run")).toBeNull());
  });
});

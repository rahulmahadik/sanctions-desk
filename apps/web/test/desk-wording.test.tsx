// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanBanner } from "../components/Banner";
import { recordLine } from "../components/DecisionPanel";
import { SummaryStrip } from "../components/Queue";
import { FourQuestions, modelCallsText, Outcome, Replay } from "../components/Record";
import { RoutingPanel } from "../components/Routing";
import { RunGraph } from "../components/RunGraph";
import { FINAL_CALL, guardWords, plainReason, readProblem, verdictWords } from "../lib/format";
import { graphAt } from "../lib/graph";
import type { QueueAlert, TraceView } from "../lib/types";
import { ANSWER, EVENTS, EVIDENCE, HUMAN, ME_APPROVER, RECORD, TRACE } from "./fixtures";

vi.mock("../lib/api", () => ({
  API_URL: "http://api.test",
  fetchQueue: vi.fn(),
  fetchExam: vi.fn(),
  fetchEvidence: vi.fn(),
  fetchTrace: vi.fn(),
  fetchRecord: vi.fn(),
  fetchEvents: vi.fn(),
  startReview: vi.fn(),
  followRun: vi.fn(),
  fetchReceiptCheck: vi.fn(),
  fetchPolicy: vi.fn(),
  fetchMe: vi.fn(),
  downloadCaseFile: vi.fn(),
  fetchHuman: vi.fn(),
  postDecision: vi.fn(),
  postSecondApproval: vi.fn(),
  postReopen: vi.fn(),
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
import { DecisionPanel } from "../components/DecisionPanel";
import * as api from "../lib/api";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchExam).mockResolvedValue({ label: "x", cases: 70, results: [], policy_version: 1 });
  vi.mocked(api.fetchMe).mockResolvedValue(ME_APPROVER);
  vi.mocked(api.fetchHuman).mockRejectedValue(new api.ApiError("no recommendation yet", 404));
  vi.mocked(api.fetchPolicy).mockRejectedValue(new api.ApiError("not needed here", 404));
});

describe("who makes the call", () => {
  it("says it in the docs' words, and never that a person makes every decision", () => {
    render(<HumanBanner />);
    const text = document.body.textContent ?? "";
    expect(FINAL_CALL).toBe("A person makes the final call; automatic closing is off by default.");
    expect(text).toContain(FINAL_CALL);
    expect(text).not.toMatch(/every decision/);
  });
});

describe("the queue summary", () => {
  const alert = (alert_id: string, status: string): QueueAlert =>
    ({ alert_id, status, recommendation: null, blocked_by: [] }) as unknown as QueueAlert;

  it("says that open is the screening system's status, out of all the alerts, with the other statuses", () => {
    render(
      <SummaryStrip
        alerts={[alert("A1", "open"), alert("A2", "open"), alert("A3", "closed"), alert("A4", "escalated")]}
        models={[]}
      />,
    );
    expect(screen.getByTestId("summary-strip").textContent).toContain(
      "2 of 4alerts open in the screening system (1 closed, 1 escalated there)",
    );
  });
});

describe("comparison reasons in plain words", () => {
  const payment = {
    ...ANSWER,
    decision: "ESCALATE_L2" as const,
    rationale:
      "Rules-based sample answer: the screener found a risk signal. Name is weak, date of birth is missing_customer, nationality is conflict.",
    key_evidence: [
      'Comparison: name 1.00 (exact) vs primary "BANK FOR DEVELOPMENT"',
      "Comparison: date of birth: missing_customer",
    ],
  };

  it("names the payment counterparty's name on a payment alert, so a weak overall match does not read as a weak name", () => {
    render(<Outcome answer={payment} alertType="payment" />);
    const key = screen.getByTestId("key-evidence").textContent ?? "";
    expect(key).toContain(
      'payment counterparty name: 1.00 exact, against the listed primary name "BANK FOR DEVELOPMENT"',
    );
    expect(key).toContain("date of birth: the payment gives no date of birth for the counterparty");
    const why = screen.getByTestId("rationale").textContent ?? "";
    expect(why).toContain("Overall match (all facts together) is weak");
    expect(why).not.toMatch(/Name is weak|missing_customer|is conflict/);
  });

  it("names the customer's name on a customer alert, and says each status in words", () => {
    expect(plainReason('name 0.54 (token_set) vs alias "X"', "customer")).toBe(
      'customer name: 0.54 same words, against the listed alias name "X"',
    );
    expect(plainReason("date of birth: missing_customer", "customer")).toBe(
      "date of birth: customer has no date of birth on record",
    );
    expect(plainReason("date of birth: missing_list")).toBe("date of birth: the list gives no date of birth");
    expect(plainReason("country: address_only")).toBe("country: only an address matches");
    expect(plainReason("country: conflict", "payment")).toBe("counterparty country: conflicts");
    expect(plainReason("date of birth: compatible")).toBe("date of birth: compatible (not ruled out)");
  });

  it("says check names and verdicts in words, and falls back to spaced words for a code it does not know", () => {
    expect(guardWords("screener_locality")).toBe("screener ran on this machine");
    expect(guardWords("guard_locality")).toBe("safety guard ran on this machine");
    expect(guardWords("critic_unresolved")).toBe("critic could not approve");
    expect(guardWords("human_in_the_loop")).toBe("a person makes the final call");
    expect(guardWords("some_new_check")).toBe("some new check");
    expect(verdictWords("pass")).toBe("passed");
    expect(verdictWords("block")).toBe("stopped it");
    expect(verdictWords("fail")).toBe("failed");
    render(
      <Outcome
        answer={{
          ...payment,
          guards: [
            { guard: "missing_data", verdict: "pass", detail: "date of birth: missing_customer" },
            { guard: "screener_locality", verdict: "block", detail: "the screener ran in the cloud" },
          ],
        }}
        alertType="customer"
      />,
    );
    const checks = document.body.textContent ?? "";
    expect(checks).toContain("missing data: passed — date of birth: customer has no date of birth on record");
    expect(checks).toContain("screener ran on this machine: stopped it");
    expect(checks).toContain("critic: approved after 2 rounds");
  });
});

describe("the sample-mode notice on the case page", () => {
  it("is shown once", async () => {
    vi.mocked(api.fetchEvidence).mockResolvedValue(EVIDENCE);
    vi.mocked(api.fetchTrace).mockResolvedValue(TRACE);
    vi.mocked(api.fetchRecord).mockResolvedValue(RECORD);
    vi.mocked(api.fetchEvents).mockResolvedValue({ run_id: "r", finished: true, events: EVENTS });
    vi.mocked(api.startReview).mockResolvedValue({
      ...ANSWER,
      sample_notice: "Sample mode: Zetaris answers are replayed from saved real queries.",
    });
    vi.mocked(api.followRun).mockReturnValue(() => undefined);
    render(<CaseView alertId="ALR-0001" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review this alert" }));
    await screen.findByTestId("verdict");
    expect(screen.getAllByTestId("sample-notice")).toHaveLength(1);
    expect((document.body.textContent ?? "").match(/Sample mode/g)).toHaveLength(1);
  });
});

describe("the decision trace in sample mode", () => {
  const standIn: TraceView = {
    ...TRACE,
    cost: {
      ...TRACE.cost,
      models: [0, 1, 2].map(() => ({
        ...(TRACE.cost.models[0] as TraceView["cost"]["models"][number]),
        model_requested: "fallback-rules",
        model_routed: "fallback-rules",
        route_kind: "local",
      })),
      totals: { ...TRACE.cost.totals, local_calls: 3, cloud_calls: 0 },
    },
  };

  it("counts the stand-in's answers as stand-in answers, not model calls", () => {
    render(<FourQuestions trace={standIn} />);
    expect(document.body.textContent).toContain("3 stand-in answers (sample mode, no model), 12 data queries");
    expect(document.body.textContent).not.toContain("model calls");
  });

  it("keeps model calls for a review a model answered", () => {
    expect(modelCallsText(TRACE)).toBe("1 model calls");
  });
});

describe("the help page", () => {
  it("names the Decide button, the analyst's limits and both kinds of second approval", async () => {
    const { Help } = await import("../components/Help");
    render(<Help />);
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("It reads Decide until you choose, then Approve or Override.");
    expect(text).toContain("can override only towards more caution");
    expect(text).toContain("An override towards a less cautious outcome needs an approver.");
    expect(text).toContain("an override to a close from any other recommendation");
    expect(text).toContain("Decline the close");
    expect(text).toContain("approver2_demo");
  });
});

describe("phone width", () => {
  it("scrolls the models table in its own named box that the keyboard can reach", () => {
    render(<RoutingPanel trace={TRACE} />);
    const box = screen.getByRole("region", { name: "Models used by step (scrolls sideways)" });
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.className).toContain("table-wrap");
    expect(box.querySelector("table")).toBeTruthy();
  });

  it("lets long pills and badges wrap, and lets grid children shrink", () => {
    const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/\.pill\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.badge\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
    expect(css).not.toMatch(/\.pill\s*\{[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.grid > \*,\s*\.flow > \*\s*\{[^}]*min-width: 0/);
  });
});

describe("the decision panel after a decision", () => {
  it("says the record was re-sealed with the decision added to the previous one", async () => {
    vi.mocked(api.fetchHuman).mockResolvedValue({
      ...HUMAN.decided,
      record_hash: "c".repeat(64),
      previous_record_hash: "a".repeat(64),
    });
    render(<DecisionPanel alertId="ALR-0001" />);
    await waitFor(() =>
      expect(screen.getByTestId("record-line").textContent).toBe(
        "(record cccccccc…cccc, which adds the decision to aaaaaaaa…aaaa)",
      ),
    );
  });

  it("shows the record alone before anyone has decided", () => {
    expect(recordLine({ record_hash: "a".repeat(64), previous_record_hash: null })).toBe("(record aaaaaaaa…aaaa)");
  });
});

describe("the replay, by clicking", () => {
  it("jumps to a step's last recorded event when its box is clicked", () => {
    render(<Replay events={EVENTS} record={RECORD} />);
    expect(screen.getByText("Click a step or an event to jump to it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Jump to the last event of Decision" }));
    expect(screen.getByLabelText(/Event 8 of 12/)).toBeTruthy();
    expect(screen.getByTestId("replay-current").textContent).toContain("decision · model answer");
    fireEvent.click(screen.getByRole("button", { name: "Jump to the last event of Critic" }));
    expect(screen.getByLabelText(/Event 9 of 12/)).toBeTruthy();
    expect(screen.getByTestId("replay-current").textContent).toContain("approved");
  });

  it("does not make a step with no recorded events a button", () => {
    render(<Replay events={EVENTS} record={RECORD} />);
    expect(screen.getByTestId("node-screener").querySelector("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Jump to the last event of Screener" })).toBeNull();
  });

  it("jumps to an event when its row is clicked, and marks that row", () => {
    render(<Replay events={EVENTS} record={RECORD} />);
    const rows = screen.getByLabelText("Recorded events").querySelectorAll("li");
    fireEvent.click(rows[3]?.querySelector("button") as HTMLButtonElement);
    expect(screen.getByLabelText(/Event 4 of 12/)).toBeTruthy();
    expect(rows[3]?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("replay-current").textContent).toContain("weak: name 1.00");
  });

  it("draws no buttons in the live graph, which has no onSelect", () => {
    render(<RunGraph view={graphAt(EVENTS)} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("signed out on a live desk", () => {
  const unauthorized = () => new api.ApiError("a valid token is required", 401);

  it("asks for the token in the welcome note instead of a demo user", async () => {
    window.localStorage.removeItem("desk.tourSeen");
    vi.mocked(api.fetchMe).mockRejectedValue(unauthorized());
    const { FirstRun } = await import("../components/FirstRun");
    render(<FirstRun />);
    const note = (await screen.findByTestId("first-run")).textContent ?? "";
    expect(note).toContain("Sign in with your token to start.");
    expect(note).not.toContain("demo user");
  });

  it("keeps the demo-user wording in sample mode", async () => {
    window.localStorage.removeItem("desk.tourSeen");
    const { FirstRun } = await import("../components/FirstRun");
    render(<FirstRun />);
    const note = (await screen.findByTestId("first-run")).textContent ?? "";
    expect(note).toContain("choose a demo user");
    expect(note).not.toContain("Sign in");
  });

  it("does not read a refused exam read as no saved run", async () => {
    const { HeadlineStrip } = await import("../components/HeadlineStrip");
    vi.mocked(api.fetchExam).mockRejectedValue(unauthorized());
    render(<HeadlineStrip />);
    const text = (await screen.findByTestId("headline-strip")).textContent ?? "";
    expect(text).toContain("Sign in to see the exam results.");
    expect(text).not.toContain("No complete exam run");
    cleanup();
    vi.mocked(api.fetchExam).mockResolvedValue({
      label: "x",
      cases: 70,
      results: [],
      policy_version: 1,
      headline: null,
      headline_sentence: null,
    });
    render(<HeadlineStrip />);
    expect((await screen.findByTestId("headline-strip")).textContent).toContain("No complete exam run is saved yet");
  });

  it("shows a neutral sign-in line for the queue, and keeps other failures red", async () => {
    const { Queue } = await import("../components/Queue");
    vi.mocked(api.fetchQueue).mockRejectedValue(unauthorized());
    render(<Queue />);
    const note = await screen.findByTestId("sign-in-note");
    expect(note.textContent).toBe("Sign in to see the alert queue.");
    expect(note.className).not.toContain("tone-stop");
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    vi.mocked(api.fetchQueue).mockRejectedValue(new api.ApiError("the API answered HTTP 500", 500));
    render(<Queue />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The queue could not be read: the API answered HTTP 500",
    );
  });

  it("maps only a 401 to a sign-in line, for any panel", () => {
    expect(readProblem(unauthorized(), "the governance page")).toEqual({
      text: "Sign in to see the governance page.",
      signIn: true,
    });
    expect(readProblem(new api.ApiError("forbidden", 403), "x")).toEqual({ text: "forbidden", signIn: false });
  });
});

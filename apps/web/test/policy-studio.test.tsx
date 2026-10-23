// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "../components/DecisionPanel";
import { PolicyStudio } from "../components/PolicyStudio";
import { Queue } from "../components/Queue";
import type { AutonomyView, MeView, PolicyVersionRow, QueueAlert, WhatIfView } from "../lib/types";
import { HUMAN, ME_ANALYST, ME_APPROVER } from "./fixtures";

vi.mock("../lib/api", () => ({
  fetchQueue: vi.fn(),
  fetchMe: vi.fn(),
  downloadCaseFile: vi.fn(),
  fetchHuman: vi.fn(),
  fetchAutonomy: vi.fn(),
  fetchAutoClosed: vi.fn(),
  fetchPolicy: vi.fn(),
  fetchPolicyVersions: vi.fn(),
  fetchPolicyAudit: vi.fn(),
  postKillSwitch: vi.fn(),
  postPolicyDraft: vi.fn(),
  postWhatIf: vi.fn(),
  postPublish: vi.fn(),
  postDiscard: vi.fn(),
  postReopen: vi.fn(),
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

import * as api from "../lib/api";

afterEach(cleanup);

const AUTONOMY: AutonomyView = {
  policy_version: 4,
  policy_level: 0,
  level_in_force: 0,
  kill_switch: { active: false },
  settings: { level: 0, autoClose: { confidenceAtLeast: 0.9, qaSampleRate: 0.1, dailyCap: 50 } },
  today: { day: "2026-10-23", auto_closed: 0, qa_sample: 0, reopened: 0, cap: 50 },
  locked: [
    "an escalation or a request for information always goes to a person",
    "a recommended block needs two different approvers",
  ],
};
const ME_ADMIN: MeView = {
  ...ME_APPROVER,
  user: { id: "admin_demo", role: "policy_admin", demo: true },
  permissions: {
    decide: false,
    approve_block: false,
    override_towards_less_caution: false,
    propose_policy: true,
    publish_policy: true,
  },
};
const DRAFT: PolicyVersionRow = {
  version: 5,
  name: "Default screening policy",
  status: "draft",
  proposed_by: "approver_demo",
  approved_by: null,
  created_at: "2026-10-23T10:00:00.000Z",
  published_at: null,
  reason: "Try level 1",
};
const WHATIF: WhatIfView = {
  current_version: 4,
  proposed_version: 5,
  cases: 30,
  changed: 0,
  new_false_closes: 0,
  less_cautious: 0,
  errors: 0,
  autonomy: {
    level: 1,
    cases: 30,
    auto_closed: 9,
    qa_sample: 2,
    human_review: 19,
    false_closes: 0,
    cap: 50,
    qa_rate: 0.1,
  },
};

function studio(me: MeView, over: { autonomy?: Partial<AutonomyView>; versions?: PolicyVersionRow[] } = {}) {
  vi.mocked(api.fetchMe).mockResolvedValue(me);
  vi.mocked(api.fetchAutonomy).mockResolvedValue({ ...AUTONOMY, ...over.autonomy });
  vi.mocked(api.fetchPolicyVersions).mockResolvedValue({ active_version: 4, versions: over.versions ?? [] });
  vi.mocked(api.fetchPolicyAudit).mockResolvedValue({ entries: [] });
  vi.mocked(api.fetchAutoClosed).mockResolvedValue({ items: [] });
  vi.mocked(api.fetchPolicy).mockResolvedValue({
    version: 4,
    hash: "h",
    policy: { name: "p", autonomy: { level: 0 } },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("the autonomy card", () => {
  it("says a person approves every alert at level 0, and lists what is locked", async () => {
    studio(ME_APPROVER);
    render(<PolicyStudio />);
    const card = await screen.findByTestId("autonomy-card");
    expect(card.textContent).toContain("level 0: a person approves every alert");
    expect(card.textContent).toContain("an escalation or a request for information always goes to a person");
    expect(card.textContent).toContain("0 closed automatically of a cap of 50");
  });

  it("lets an approver force level 0 with a reason, and only a policy admin switch it back on", async () => {
    studio(ME_APPROVER, { autonomy: { policy_level: 1, level_in_force: 1 } });
    vi.mocked(api.postKillSwitch).mockResolvedValue({ ...AUTONOMY, level_in_force: 0 });
    const first = render(<PolicyStudio />);
    const stop = (await screen.findByRole("button", { name: /Kill switch/ })) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    fireEvent.change(within(screen.getByTestId("autonomy-card")).getByRole("textbox"), {
      target: { value: "QA found a wrong automatic close." },
    });
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(api.postKillSwitch).toHaveBeenCalledWith(true, "QA found a wrong automatic close."));
    first.unmount();

    studio(ME_APPROVER, {
      autonomy: {
        kill_switch: { active: true, by: "approver_demo", at: "now", reason: "QA found a wrong automatic close." },
        level_in_force: 0,
        policy_level: 1,
      },
    });
    render(<PolicyStudio />);
    expect(await screen.findByText(/Kill switch is on/)).toBeTruthy();
    fireEvent.change(within(screen.getByTestId("autonomy-card")).getByRole("textbox"), {
      target: { value: "Fixed and reviewed by QA." },
    });
    expect((screen.getByRole("button", { name: "Switch autonomy back on" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("changing autonomy", () => {
  it("does not allow a quality-assurance sample below 5 percent, and needs a reason", async () => {
    studio(ME_APPROVER);
    render(<PolicyStudio />);
    const create = (await screen.findByRole("button", { name: "Create a draft" })) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/Quality-assurance sample/), { target: { value: "4" } });
    expect(screen.getByText("The quality-assurance sample must be at least 5%.")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Quality-assurance sample/), { target: { value: "10" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Reason/, { selector: "input[maxlength='500']" }), {
      target: { value: "Try level one on the exam." },
    });
    expect(create.disabled).toBe(false);
  });

  it("sends the active policy with only the autonomy section changed", async () => {
    studio(ME_APPROVER);
    vi.mocked(api.postPolicyDraft).mockResolvedValue(DRAFT);
    render(<PolicyStudio />);
    fireEvent.click(await screen.findByLabelText(/1: certain closes are closed automatically/));
    fireEvent.change(screen.getByLabelText(/^Reason/, { selector: "input[maxlength='500']" }), {
      target: { value: "Try level one on the exam." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create a draft" }));
    await waitFor(() => expect(api.postPolicyDraft).toHaveBeenCalled());
    const [policy, reason] = vi.mocked(api.postPolicyDraft).mock.calls[0] ?? [];
    expect(policy).toMatchObject({
      name: "p",
      autonomy: { level: 1, autoClose: { confidenceAtLeast: 0.9, qaSampleRate: 0.1, dailyCap: 50 } },
    });
    expect(reason).toBe("Try level one on the exam.");
  });

  it("previews a draft on the exam with the counts, and flags false closes", async () => {
    studio(ME_ADMIN, { versions: [DRAFT] });
    vi.mocked(api.postWhatIf).mockResolvedValue(WHATIF);
    render(<PolicyStudio />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview on the exam" }));
    const box = await screen.findByTestId("whatif-autonomy");
    expect(box.textContent).toContain("9 would be closed automatically");
    expect(box.textContent).toContain("2 sampled for quality assurance (10%)");
    expect(box.textContent).toContain("False closes on the exam: 0 (must be 0).");
    cleanup();

    vi.mocked(api.postWhatIf).mockResolvedValue({
      ...WHATIF,
      autonomy: { ...(WHATIF.autonomy as NonNullable<WhatIfView["autonomy"]>), false_closes: 1 },
    });
    render(<PolicyStudio />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview on the exam" }));
    expect((await screen.findByTestId("whatif-autonomy")).textContent).toContain("Do not publish this draft.");
  });

  it("will not let the author publish their own draft, or anyone but a policy admin", async () => {
    studio({ ...ME_ADMIN, user: { id: "approver_demo", role: "policy_admin", demo: true } }, { versions: [DRAFT] });
    const own = render(<PolicyStudio />);
    expect(((await screen.findByRole("button", { name: "Publish" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You wrote this draft; a different policy admin must publish it/)).toBeTruthy();
    own.unmount();

    studio(ME_APPROVER, { versions: [DRAFT] });
    const approver = render(<PolicyStudio />);
    expect(((await screen.findByRole("button", { name: "Publish" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Only a policy admin can publish.")).toBeTruthy();
    approver.unmount();

    studio(ME_ADMIN, { versions: [DRAFT] });
    vi.mocked(api.postPublish).mockResolvedValue({ published: 5 });
    render(<PolicyStudio />);
    const publish = (await screen.findByRole("button", { name: "Publish" })) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await waitFor(() => expect(api.postPublish).toHaveBeenCalledWith(5));
  });
});

describe("the badges and the reopen button", () => {
  const alert = (over: Partial<QueueAlert>): QueueAlert => ({
    alert_id: "ALR-0001",
    alert_type: "customer",
    alert_source: "customer_name",
    customer_id: "C",
    entry_id: "E",
    matched_name: "A B",
    match_score: 0.9,
    status: "open",
    recommendation: "CLOSE_FALSE_POSITIVE",
    record_hash: "a".repeat(64),
    ...over,
  });

  it("marks each alert as human-approved, auto-closed or a QA sample", async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue({
      sample_mode: true,
      alerts: [
        alert({ alert_id: "ALR-1", human_status: "decided", human_final: "CLOSE_FALSE_POSITIVE" }),
        alert({
          alert_id: "ALR-2",
          human_status: "auto_closed",
          human_final: "CLOSE_FALSE_POSITIVE",
          autonomy_outcome: "auto_closed",
        }),
        alert({ alert_id: "ALR-3", human_status: "awaiting", autonomy_outcome: "qa_sample" }),
        alert({ alert_id: "ALR-4", human_status: "awaiting" }),
      ],
    });
    render(<Queue />);
    expect(await screen.findByText("human-approved: Close as false positive")).toBeTruthy();
    expect(screen.getByText("auto-closed")).toBeTruthy();
    expect(screen.getByText("QA sample: a person decides")).toBeTruthy();
    expect(screen.getByText("waiting for a person")).toBeTruthy();
  });

  it("shows an automatic close with its statement, and lets an analyst reopen it with a reason", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME_ANALYST);
    const closed = {
      ...HUMAN.awaiting,
      status: "auto_closed" as const,
      final: "CLOSE_FALSE_POSITIVE" as const,
      autonomy: {
        outcome: "auto_closed" as const,
        statement: "closed automatically under policy v4, level 1, conditions met: level_one",
        level_in_force: 1 as const,
      },
    };
    vi.mocked(api.fetchHuman).mockResolvedValue(closed);
    vi.mocked(api.postReopen).mockResolvedValue({ ...HUMAN.awaiting, status: "awaiting" });
    render(<DecisionPanel alertId="ALR-0001" />);
    expect((await screen.findByTestId("auto-closed-statement")).textContent).toContain(
      "closed automatically under policy v4, level 1",
    );
    const button = screen.getByRole("button", { name: "Reopen this close" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "I want to read the evidence again." } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.postReopen).toHaveBeenCalledWith("ALR-0001", {
        reason: "I want to read the evidence again.",
        record_hash: closed.record_hash,
      }),
    );
  });
});

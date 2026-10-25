// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permissionFor } from "../../../apps/api/src/access";
import { ROLES, PERMISSIONS as SERVER_PERMISSIONS } from "../../../packages/shared/src/auth";
import { ACTIONS, type Action, actionProblem, PERMISSIONS, refusal } from "../lib/permissions";
import type { MeView, PolicyVersionRow } from "../lib/types";
import { HUMAN, ME_ANALYST, ME_APPROVER, ME_VIEWER } from "./fixtures";

vi.mock("../lib/api", () => ({
  API_URL: "http://api.test",
  fetchMe: vi.fn(),
  fetchHuman: vi.fn(),
  fetchEvidence: vi.fn(),
  fetchTrace: vi.fn(),
  fetchRecord: vi.fn(),
  fetchEvents: vi.fn(),
  fetchExam: vi.fn(),
  fetchPolicy: vi.fn(),
  startReview: vi.fn(),
  followRun: vi.fn(),
  downloadCaseFile: vi.fn(),
  postDecision: vi.fn(),
  postSecondApproval: vi.fn(),
  postReopen: vi.fn(),
  postListChange: vi.fn(),
  fetchAutonomy: vi.fn(),
  fetchAutoClosed: vi.fn(),
  fetchPolicyVersions: vi.fn(),
  fetchPolicyAudit: vi.fn(),
  postKillSwitch: vi.fn(),
  postPolicyDraft: vi.fn(),
  postWhatIf: vi.fn(),
  postPublish: vi.fn(),
  postDiscard: vi.fn(),
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
import { ListChangePanel } from "../components/ListChange";
import { PolicyStudio } from "../components/PolicyStudio";
import * as api from "../lib/api";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchMe).mockResolvedValue(ME_VIEWER);
  vi.mocked(api.fetchHuman).mockRejectedValue(new api.ApiError("no recommendation yet", 404));
  vi.mocked(api.fetchEvidence).mockRejectedValue(new api.ApiError("not needed here", 404));
  vi.mocked(api.fetchTrace).mockRejectedValue(new api.ApiError("not needed here", 404));
  vi.mocked(api.fetchRecord).mockRejectedValue(new api.ApiError("not needed here", 404));
  vi.mocked(api.fetchExam).mockRejectedValue(new api.ApiError("not needed here", 404));
  vi.mocked(api.fetchPolicy).mockRejectedValue(new api.ApiError("not needed here", 404));
});

const me = (id: string, role: MeView["user"]["role"], auth: MeView["auth"] = "on"): MeView => ({
  ...ME_VIEWER,
  auth,
  user: { id, role, demo: auth === "demo" },
});

/** The route each action calls, as the web sends it. */
const ROUTE: Record<Action, string> = {
  review: "/run",
  listChange: "/list-change/replay",
  preview: "/policy/whatif",
  decide: "/cases/:alertId/decision",
  reopen: "/cases/:alertId/reopen",
  overrideLessCautious: "/cases/:alertId/decision",
  secondApproval: "/cases/:alertId/second-approval",
  propose: "/policy/drafts",
  discard: "/policy/drafts/:version/discard",
  publish: "/policy/drafts/:version/publish",
  stopAutonomy: "/autonomy/kill-switch",
  restoreAutonomy: "/autonomy/kill-switch",
};

describe("the permission rules on screen", () => {
  it("are the same as the server's permission map", () => {
    expect(PERMISSIONS).toEqual(SERVER_PERMISSIONS);
  });

  it("name the same route check the server makes for every action", () => {
    for (const action of Object.keys(ACTIONS) as Action[])
      expect(permissionFor("POST", ROUTE[action]), action).toBe(ACTIONS[action].route);
  });

  it("never grey out what a role is allowed, and always grey out what it is not (sign-in on)", () => {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      const rule = ACTIONS[action];
      for (const role of ROLES) {
        const allowed = [rule.route, ...rule.handler].every((p) =>
          (SERVER_PERMISSIONS[p] as readonly string[]).includes(role),
        );
        expect(refusal(me("someone", role), action) === undefined, `${role} ${action}`).toBe(allowed);
      }
    }
  });

  it("say the plain sentence for each refusal", () => {
    const analyst = me("ann", "analyst");
    expect(refusal(analyst, "discard")).toBe("Only an approver or a policy admin can discard a draft.");
    expect(refusal(analyst, "publish")).toBe("Only a policy admin can publish a draft.");
    expect(refusal(analyst, "secondApproval")).toBe("Only an approver can give the second approval.");
    expect(refusal(analyst, "restoreAutonomy")).toBe("Only a policy admin can switch autonomy back on.");
    expect(refusal(me("vic", "viewer"), "review")).toBe(
      "Only an analyst, an approver or a policy admin can start a review.",
    );
    expect(refusal(me("pat", "policy_admin"), "decide")).toBe("Only an analyst or an approver can record a decision.");
    expect(refusal("signed_out", "review")).toBe("Sign in to start a review.");
  });

  it("apply the four-eyes rules: the first approver and the author cannot take the second step", () => {
    const olga = me("olga", "approver");
    expect(refusal(olga, "secondApproval", { firstActor: "olga" })).toBe(
      "A different approver must give the second approval.",
    );
    expect(refusal(olga, "secondApproval", { firstActor: "ann" })).toBeUndefined();
    const pat = me("pat", "policy_admin");
    expect(refusal(pat, "publish", { proposedBy: "pat" })).toBe("A different policy admin must publish this draft.");
    expect(refusal(pat, "publish", { proposedBy: "olga" })).toBeUndefined();
  });

  it("follow the sign-in mode: in sample mode anyone may review; with sign-in off only the handler checks apply", () => {
    expect(refusal(ME_VIEWER, "review")).toBeUndefined();
    expect(refusal(ME_VIEWER, "listChange")).toBeUndefined();
    expect(refusal(ME_VIEWER, "preview")).toBeUndefined();
    expect(refusal(ME_VIEWER, "decide")).toBe("Only an analyst or an approver can record a decision.");
    const off = me("anonymous", "viewer", "off");
    expect(refusal(off, "propose")).toBeUndefined();
    expect(refusal(off, "stopAutonomy")).toBeUndefined();
    expect(refusal(off, "decide")).toBeDefined();
    expect(refusal(off, "restoreAutonomy")).toBeDefined();
  });

  it("grey out nothing while it is not known who is using the screen", () => {
    for (const action of Object.keys(ACTIONS) as Action[]) expect(refusal(undefined, action)).toBeUndefined();
  });

  it("say a server refusal (403) as the same plain sentence, and leave other failures as they are", () => {
    const forbidden = (m: string) => new api.ApiError(m, 403);
    expect(actionProblem(forbidden("analyst may not do this"), "discard")).toBe(
      "Only an approver or a policy admin can discard a draft.",
    );
    expect(actionProblem(forbidden("choose a demo user (the X-Demo-User header) to do this"), "decide")).toBe(
      "Only an analyst or an approver can record a decision.",
    );
    expect(actionProblem(forbidden("the second approval must come from a different person"), "secondApproval")).toBe(
      "A different approver must give the second approval.",
    );
    expect(actionProblem(new api.ApiError("a valid token is required", 401), "review")).toBe(
      "Sign in to start a review.",
    );
    expect(actionProblem(new api.ApiError("the recommendation changed", 409), "decide")).toBe(
      "the recommendation changed",
    );
  });
});

/** The reason linked to a greyed-out button. */
const reasonOf = (button: HTMLElement): string | null => {
  const id = button.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
};

describe("greyed-out buttons", () => {
  it("asks a signed-out person to sign in before starting a review", async () => {
    vi.mocked(api.fetchMe).mockRejectedValue(new api.ApiError("a valid token is required", 401));
    render(<CaseView alertId="ALR-0001" />);
    const button = (await screen.findByRole("button", { name: "Review this alert" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(reasonOf(button)).toBe("Sign in to start a review.");
  });

  it("lets a sample-mode visitor start a review", async () => {
    render(<CaseView alertId="ALR-0001" />);
    const button = (await screen.findByRole("button", { name: "Review this alert" })) as HTMLButtonElement;
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("says a refused review in plain words, not the server's role message", async () => {
    vi.mocked(api.startReview).mockRejectedValue(new api.ApiError("viewer may not do this", 403));
    vi.mocked(api.followRun).mockReturnValue(() => undefined);
    render(<CaseView alertId="ALR-0001" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review this alert" }));
    expect(await screen.findByText("Only an analyst, an approver or a policy admin can start a review.")).toBeTruthy();
    expect(screen.queryByText(/may not do this/)).toBeNull();
  });

  it("greys out the list check for a signed-in viewer", async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(me("vic", "viewer"));
    render(<ListChangePanel />);
    const button = (await screen.findByRole("button", { name: /Check earlier decisions/ })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(reasonOf(button)).toBe(
      "Only an analyst, an approver or a policy admin can check earlier decisions against the list.",
    );
  });

  it("greys out the second approval for an analyst, and says a refused one plainly", async () => {
    vi.mocked(api.fetchHuman).mockResolvedValue(HUMAN.blockPending);
    vi.mocked(api.fetchMe).mockResolvedValue({
      ...ME_ANALYST,
      user: { id: "someone_else", role: "analyst", demo: true },
    });
    const first = render(<DecisionPanel alertId="ALR-0001" />);
    const give = (await screen.findByRole("button", { name: "Give the second approval" })) as HTMLButtonElement;
    await waitFor(() => expect(reasonOf(give)).toBe("Only an approver can give the second approval."));
    expect(give.disabled).toBe(true);
    first.unmount();

    // The screen thought it was allowed, the server refused: the plain sentence, not the raw message.
    vi.mocked(api.fetchMe).mockResolvedValue({
      ...ME_APPROVER,
      user: { id: "approver2_demo", role: "approver", demo: true },
    });
    vi.mocked(api.postSecondApproval).mockRejectedValue(
      new api.ApiError("the second approval must come from a different person", 403),
    );
    render(<DecisionPanel alertId="ALR-0001" />);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Confirmed after reading the evidence." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Give the second approval" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A different approver must give the second approval.");
  });
});

describe("Policy Studio buttons by role", () => {
  const DRAFT: PolicyVersionRow = {
    version: 5,
    name: "Default screening policy",
    status: "draft",
    proposed_by: "admin_demo",
    approved_by: null,
    created_at: "2026-10-23T10:00:00.000Z",
    published_at: null,
    reason: "Try level 1",
  };
  const studio = (who: MeView) => {
    vi.mocked(api.fetchMe).mockResolvedValue(who);
    vi.mocked(api.fetchAutonomy).mockResolvedValue({
      policy_version: 4,
      policy_level: 0,
      level_in_force: 0,
      kill_switch: { active: false },
      settings: { level: 0, autoClose: { confidenceAtLeast: 0.9, qaSampleRate: 0.1, dailyCap: 50 } },
      today: { day: "2026-10-23", auto_closed: 0, qa_sample: 0, reopened: 0, cap: 50 },
      locked: [],
    });
    vi.mocked(api.fetchPolicyVersions).mockResolvedValue({ active_version: 4, versions: [DRAFT] });
    vi.mocked(api.fetchPolicyAudit).mockResolvedValue({ entries: [] });
    vi.mocked(api.fetchAutoClosed).mockResolvedValue({ items: [] });
  };
  const button = async (name: string) => (await screen.findByRole("button", { name })) as HTMLButtonElement;

  it("greys out every policy change for an analyst, each with its reason, and leaves the preview open", async () => {
    studio(ME_ANALYST);
    render(<PolicyStudio />);
    expect(reasonOf(await button("Create a draft"))).toBe(
      "Only an approver or a policy admin can propose a policy change.",
    );
    expect(reasonOf(await button("Discard"))).toBe("Only an approver or a policy admin can discard a draft.");
    expect(reasonOf(await button("Publish"))).toBe("Only a policy admin can publish a draft.");
    expect(reasonOf(await button("Kill switch: force level 0 now"))).toBe(
      "Only an approver or a policy admin can stop autonomy.",
    );
    for (const name of ["Create a draft", "Discard", "Publish", "Kill switch: force level 0 now"])
      expect((await button(name)).disabled, name).toBe(true);
    const preview = await button("Preview on the exam");
    expect(preview.disabled).toBe(false);
    expect(preview.getAttribute("aria-describedby")).toBeNull();
  });

  it("lets admin2_demo publish a draft admin_demo wrote, and not admin_demo", async () => {
    studio({ ...ME_APPROVER, user: { id: "admin_demo", role: "policy_admin", demo: true } });
    const own = render(<PolicyStudio />);
    expect(reasonOf(await button("Publish"))).toBe("A different policy admin must publish this draft.");
    expect((await button("Discard")).disabled).toBe(false);
    own.unmount();

    studio({ ...ME_APPROVER, user: { id: "admin2_demo", role: "policy_admin", demo: true } });
    vi.mocked(api.postPublish).mockResolvedValue({ published: 5 });
    render(<PolicyStudio />);
    const publish = await button("Publish");
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await waitFor(() => expect(api.postPublish).toHaveBeenCalledWith(5));
  });

  it("says a refused discard in plain words, not the server's role message", async () => {
    studio({ ...ME_APPROVER, user: { id: "admin2_demo", role: "policy_admin", demo: true } });
    vi.mocked(api.postDiscard).mockRejectedValue(new api.ApiError("analyst may not do this", 403));
    render(<PolicyStudio />);
    fireEvent.click(await button("Discard"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Only an approver or a policy admin can discard a draft.",
    );
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlockedByChips, OUTCOME, OutcomeBadge, SeverityBadge } from "../components/Badges";
import { CaseBanner, oneLine } from "../components/CaseBanner";
import { bySeverity, SummaryStrip } from "../components/Queue";
import type { QueueAlert } from "../lib/types";

afterEach(cleanup);

const alert = (over: Partial<QueueAlert>): QueueAlert => ({
  alert_id: "ALR-0001",
  alert_type: "customer",
  alert_source: "customer_name",
  customer_id: "C",
  entry_id: "E",
  matched_name: "X",
  match_score: 0.9,
  status: "open",
  recommendation: null,
  record_hash: null,
  ...over,
});

describe("outcome badges", () => {
  it("use one palette, each with an icon and words, never colour alone", () => {
    const cases = [
      ["RECOMMEND_BLOCK", "block", "Block (two approvals)"],
      ["ESCALATE_L2", "escalate", "Escalate"],
      ["NEED_MORE_INFO", "info", "Need more info"],
      ["CLOSE_FALSE_POSITIVE", "close", "Close"],
      [null, "pending", "Not reviewed"],
    ] as const;
    for (const [decision, tone, text] of cases) {
      render(<OutcomeBadge decision={decision} />);
      const badge = screen.getByTestId("outcome-badge");
      expect(badge.getAttribute("data-tone")).toBe(tone);
      expect(badge.textContent).toContain(text);
      const icon = badge.querySelector(".icon");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.textContent).toBe(OUTCOME[decision ?? "pending"].icon);
      cleanup();
    }
  });

  it("give severity words and the rule behind them", () => {
    render(<SeverityBadge severity="medium" threshold={0.85} />);
    const badge = screen.getByTestId("severity-badge");
    expect(badge.textContent).toContain("Medium");
    expect(badge.getAttribute("title")).toContain("0.85");
    expect(badge.getAttribute("data-tone")).toBe("escalate");
  });

  it("show one 'blocked by' chip per check, and nothing when no close was stopped", () => {
    render(<BlockedByChips by={["policy guard", "critic"]} />);
    expect(screen.getAllByTestId("blocked-by").map((c) => c.textContent)).toEqual([
      "⊘blocked by policy guard",
      "⊘blocked by critic",
    ]);
    cleanup();
    const { container } = render(<BlockedByChips by={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("case banner", () => {
  it("shows the recommendation, a one-line reason and what stopped a close", () => {
    render(
      <CaseBanner
        decision="ESCALATE_L2"
        rationale="The payment names a watched city. More text follows here."
        closeStop={{ stopped: true, by: ["policy guard"], reasons: ["jurisdiction: watched jurisdiction: IR"] }}
      />,
    );
    const banner = screen.getByTestId("case-banner");
    expect(banner.getAttribute("data-tone")).toBe("escalate");
    expect(within(banner).getByTestId("outcome-badge").textContent).toContain("Escalate");
    expect(screen.getByTestId("case-reason").textContent).toBe("The payment names a watched city.");
    expect(screen.getByTestId("case-stopped").textContent).toContain("blocked by policy guard");
    expect(screen.getByTestId("case-stopped").textContent).toContain("watched jurisdiction: IR");
  });

  it("says when no close was stopped, and shows nothing before a recommendation", () => {
    render(
      <CaseBanner decision="CLOSE_FALSE_POSITIVE" rationale="" closeStop={{ stopped: false, by: [], reasons: [] }} />,
    );
    expect(screen.getByTestId("case-stopped").textContent).toContain("No close was proposed and stopped");
    expect(screen.getByTestId("case-reason").textContent).toBe("No reason was recorded.");
    cleanup();
    const { container } = render(<CaseBanner decision={undefined} />);
    expect(container.textContent).toBe("");
    expect(oneLine("x".repeat(300)).length).toBe(220);
  });
});

describe("queue summary and order", () => {
  it("counts only what the data says", () => {
    render(
      <SummaryStrip
        alerts={[
          alert({ status: "open" }),
          alert({ status: "open", recommendation: "ESCALATE_L2", human_status: "awaiting", blocked_by: ["critic"] }),
          alert({ status: "closed", recommendation: "CLOSE_FALSE_POSITIVE", human_status: "approved" as never }),
        ]}
        models={[{ model: "nvidia/nemotron-3-ultra-550b-a55b", route: "cloud", calls: 3 }]}
      />,
    );
    const strip = screen.getByTestId("summary-strip").textContent ?? "";
    expect(strip).toContain("2 of 3alerts open in the screening system (1 closed there)");
    expect(strip).toContain("1recommendations waiting for a person");
    expect(strip).toContain("1closes stopped by a check");
    expect(strip).toContain("Nemotron 3 Ultra 550B (cloud) 3");
  });

  it("puts the most severe first and keeps the id order within a severity", () => {
    const sorted = [
      alert({ alert_id: "ALR-0003", severity: "low" }),
      alert({ alert_id: "ALR-0002", severity: "high" }),
      alert({ alert_id: "ALR-0001", severity: "high" }),
      alert({ alert_id: "ALR-0004", severity: "medium" }),
    ].sort(bySeverity);
    expect(sorted.map((a) => a.alert_id)).toEqual(["ALR-0001", "ALR-0002", "ALR-0004", "ALR-0003"]);
  });
});

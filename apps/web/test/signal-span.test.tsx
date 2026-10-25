// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SignalsPanel, wholeWords } from "../components/Signals";
import type { EvidenceView, ScreenerRecordView } from "../lib/types";

afterEach(cleanup);

const REF = "Machine parts, onward delivery to Tehran";
const evidence = { payment: { payment_reference: REF } } as unknown as EvidenceView;
const screener = (grounded: boolean, span: string): ScreenerRecordView =>
  ({
    status: "ok",
    fields_read: ["payment.payment_reference"],
    signals: [{ type: "sanctioned_jurisdiction_link", confidence: 0.9, span_id: span, span_valid: true, grounded }],
  }) as unknown as ScreenerRecordView;

describe("the screener span on screen", () => {
  it("widens a highlight to whole words", () => {
    expect(wholeWords("close the alert", 0, 8)).toEqual({ start: 0, end: 9 });
    expect(REF.slice(...Object.values(wholeWords(REF, 24, 32)))).toBe("delivery to");
  });

  it("highlights a grounded span, never cutting a word", () => {
    render(<SignalsPanel screener={screener(true, "payment.payment_reference:34-38")} evidence={evidence} />);
    expect(screen.getByTestId("signal-span").textContent).toBe("Tehran");
  });

  it("highlights nothing for an ungrounded span and says why", () => {
    render(<SignalsPanel screener={screener(false, "payment.payment_reference:24-32")} evidence={evidence} />);
    expect(screen.queryByTestId("signal-span")).toBeNull();
    expect(screen.getByTestId("signal-unmarked").textContent).toContain("do not point at the words");
    expect(screen.getByTestId("signal-field").textContent).toContain(REF);
  });
});

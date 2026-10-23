import { describe, expect, it } from "vitest";
import { assessNote, DEFAULT_EVIDENCE_STANDARD } from "../src/evidence-standard.js";

describe("a note that counts as documentary evidence", () => {
  it.each([
    "Identity verified at branch visit (KYC-482113): passport ZP1234567, date of birth 1975-03-02.",
    "National ID checked by compliance (KYC-990211): born 1991-07-09, ID 12345678.",
    "Registered pharmacist, council no. 2345678, born 1983-02-11; verified KYC-304455.",
    "Passport ZQ7654321 seen and copied at onboarding (ref CDD 20931); date of birth 14 March 1980.",
  ])("has a check reference, a document number and a date: %s", (text) => {
    expect(assessNote({ text })).toEqual({ documentary: true, missing: [] });
  });

  it("for a payment also needs a named counterparty", () => {
    const text = "Refund checked (KYC-482113): passport ZP1234567 issued 2019-05-02.";
    expect(assessNote({ text, payment: { counterpartyName: "Bridge Marine Services Ltd" } }).documentary).toBe(true);
    expect(assessNote({ text, payment: { counterpartyName: "  " } })).toEqual({
      documentary: false,
      missing: ["a named counterparty"],
    });
    expect(assessNote({ text, payment: { counterpartyName: "unknown" } }).missing).toEqual(["a named counterparty"]);
  });
});

describe("a note that is only a claim", () => {
  it("names each element that is missing", () => {
    expect(
      assessNote({ text: "Mother's name Houria Benali; father's name Said. Identity card checked at branch." }),
    ).toEqual({ documentary: false, missing: ["a check reference", "a document number", "a date"] });
    expect(assessNote({ text: "Passport copy on file shows date of birth 1962-04-11." }).missing).toEqual([
      "a check reference",
      "a document number",
    ]);
    expect(assessNote({ text: "Checked (KYC-482113), passport ZP1234567." }).missing).toEqual(["a date"]);
    expect(assessNote({ text: "Passport ZP1234567 issued 2019-05-02." }).missing).toEqual(["a check reference"]);
    expect(assessNote({ text: "Checked (KYC-482113) on 2026-10-01; passport seen." }).missing).toEqual([
      "a document number",
    ]);
  });

  it("does not let the check reference double as the document number", () => {
    expect(assessNote({ text: "Verified KYC-4821130 on 2026-10-01." }).missing).toEqual(["a document number"]);
  });

  it("treats an empty or missing note as a claim with everything missing", () => {
    expect(assessNote({ text: null }).documentary).toBe(false);
    expect(assessNote({ text: "" }).missing).toHaveLength(3);
  });

  it("follows the policy when an element is not required", () => {
    const relaxed = { ...DEFAULT_EVIDENCE_STANDARD, requireDate: false };
    expect(assessNote({ text: "Checked (KYC-482113), passport ZP1234567." }, relaxed).documentary).toBe(true);
  });

  it("does not take a payroll line or an invoice number for a check", () => {
    expect(assessNote({ text: "Salary April, employee 4471, born 1989-02-11, payroll batch 26-04" }).documentary).toBe(
      false,
    );
    expect(
      assessNote({
        text: "Invoice 20261-77 to Pty, company no. 123456789, Auckland NZ",
        payment: { counterpartyName: "X Pty" },
      }).missing,
    ).toEqual(["a check reference", "a date"]);
  });
});

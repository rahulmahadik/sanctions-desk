import { loadPolicyFile } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { type EvidenceBundle, gatherEvidence, matchEvidence } from "../src/index.js";
import { caseFacts, sampleDeps } from "./helpers.js";

/**
 * A customer with no date of birth on record: a note that meets the documentary standard supplies one, a claim does
 * not. Uses the sample exam case with an exact-name false positive and changes only the customer's notes.
 */
const facts = caseFacts("fp_dob_exact_name_0");

async function matchWithNote(notes: string | null) {
  const deps = sampleDeps();
  const evidence = await gatherEvidence(deps, facts.alertId);
  const edited = {
    ...evidence,
    customer: { ...evidence.customer, date_of_birth: null, notes },
  } as unknown as EvidenceBundle;
  return { match: matchEvidence(deps, edited), policy: loadPolicyFile("config/policy.default.json") };
}

describe("a note and the date of birth", () => {
  it("supplies the date of birth when it carries a check reference, a document number and a date", async () => {
    const { match } = await matchWithNote(
      "Identity verified at branch visit (KYC-482113): passport ZP1234567, date of birth 1975-03-02.",
    );
    expect(match.documentaryDateOfBirth).toBe("1975-03-02");
    expect(match.comparison.dob.status).not.toBe("missing_customer");
  });

  it("does not supply it when the note is only a claim", async () => {
    const { match } = await matchWithNote("Passport copy on file shows date of birth 1975-03-02.");
    expect(match.documentaryDateOfBirth).toBeUndefined();
    expect(match.comparison.dob.status).toBe("missing_customer");
  });
});

import { describe, expect, it } from "vitest";
import { chooseDecision, type Evidence } from "../src/index.js";

const withMatch = (comparison: NonNullable<Evidence["comparison"]>): Evidence => ({ comparison });

describe("code's first finding for each kind of match", () => {
  it("puts a met true match forward for a block", () => {
    const pick = chooseDecision(withMatch({ definitions_met: { true_match: true } }));
    expect(pick).toMatchObject({ decision: "RECOMMEND_BLOCK", settled: true });
  });

  it("escalates a counterparty match, a matching document number and a strong assessment", () => {
    for (const comparison of [
      { definitions_met: { counterparty_match: true } },
      { identifiers: "match" },
      { assessment: "strong" },
    ])
      expect(chooseDecision(withMatch(comparison)).decision).toBe("ESCALATE_L2");
  });

  it("never turns a met true match into a close, whatever else the comparison says", () => {
    for (const false_positive of [true, false])
      for (const counterparty_match of [true, false])
        for (const identifiers of ["match", "none", undefined])
          for (const assessment of ["strong", "possible", "weak", undefined])
            for (const close_blockers of [[], ["a failing data-quality rule on date_of_birth"]])
              for (const ownership of [undefined, "below", "met", "unknown"]) {
                const pick = chooseDecision(
                  withMatch({
                    definitions_met: { true_match: true, false_positive, counterparty_match, ownership },
                    identifiers,
                    assessment,
                    close_blockers,
                  }),
                );
                expect(pick.decision).toBe("RECOMMEND_BLOCK");
              }
  });
});

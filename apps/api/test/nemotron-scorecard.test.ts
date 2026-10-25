import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { formatMarkdown } from "../../../tools/lib/format-markdown.js";
import {
  BLOCK_RE,
  brier,
  buildScorecard,
  checkStepsAgainstDoc,
  renderScorecard,
  resultRow,
} from "../../../tools/lib/nemotron-scorecard.js";

describe("the Brier score of the Nemotron scorecard", () => {
  it("is the mean of (confidence - y) squared, y = 1 when the outcome is acceptable", () => {
    const cases = [
      { expected: "ESCALATE_L2", got: "ESCALATE_L2", confidence: 0.9 }, // (0.9 - 1)^2 = 0.01
      { expected: "ESCALATE_L2", acceptable: ["HOLD"], got: "HOLD", confidence: 0.6 }, // (0.6 - 1)^2 = 0.16
      { expected: "ESCALATE_L2", got: "CLOSE_FALSE_POSITIVE", confidence: 0.8 }, // (0.8 - 0)^2 = 0.64
      { expected: "ESCALATE_L2", got: "ERROR", confidence: 0.5 }, // errors are left out
      { expected: "ESCALATE_L2", got: "ESCALATE_L2" }, // no confidence: left out
    ];
    expect(brier(cases)).toEqual({ n: 3, brier: 0.27 });
    expect(brier([])).toEqual({ n: 0, brier: null });
  });

  it("adds a new exam result with confidences as its own arm, and skips one without", () => {
    const cases = [{ expected: "ESCALATE_L2", got: "ESCALATE_L2", confidence: 0.5 }];
    expect(resultRow("eval/results/x-sys5-routed.json", { variant: "routed", system: "sys5", cases })).toEqual({
      arm: "Full system (sys5) (exam, 1 cases, one run)",
      cases_with_confidence: 1,
      brier: 0.25,
      source: "eval/results/x-sys5-routed.json",
    });
    const alone = resultRow("eval/results/x-nemotron_alone.json", { variant: "nemotron_alone", cases });
    expect(alone?.arm).toBe("Nemotron alone, no free text (exam, 1 cases, one run)");
    expect(resultRow("r.json", { variant: "routed", cases: [{ expected: "A", got: "A" }] })).toBeNull();
  });
});

describe("the Nemotron scorecard block", () => {
  const root = resolveProjectPath(".");
  const card = buildScorecard(root);

  it("matches eval/nemotron-scorecard.json and the block in docs/NEMOTRON.md", () => {
    const jsonFile = resolveProjectPath("eval/nemotron-scorecard.json");
    expect(readFileSync(jsonFile, "utf8")).toBe(formatMarkdown(`${JSON.stringify(card, null, 2)}\n`, jsonFile));
    const docFile = resolveProjectPath("docs/NEMOTRON.md");
    const doc = readFileSync(docFile, "utf8");
    const next = doc.replace(
      BLOCK_RE,
      () => `<!-- nemotron-scorecard:start -->\n${renderScorecard(card)}\n<!-- nemotron-scorecard:end -->`,
    );
    expect(formatMarkdown(next, docFile)).toBe(doc);
    expect(() => checkStepsAgainstDoc(doc)).not.toThrow();
  });

  it("reads the guard results from the committed runs, with Wilson ranges", () => {
    for (const g of card.guard) {
      expect(g.low).toBeLessThanOrEqual(Math.round((100 * g.x) / g.n));
      expect(g.high).toBeGreaterThanOrEqual(Math.round((100 * g.x) / g.n));
    }
    expect(card.local_share.local_calls).toBeLessThanOrEqual(card.local_share.all_calls);
  });
});

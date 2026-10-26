import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { localModeLine, type ReceiptScan, receiptsLine } from "../../../tools/lib/receipts-scan.js";
import { RUN_GROUP_ORDER } from "../../../tools/lib/run-groups.js";

/**
 * The run counts the README states as facts (npm run readme:refresh writes them; CI checks they are current). Here the
 * sentence that splits the exported runs is read back: its numbers add up, and each is the count the receipt
 * statistics and the receipt check hold for that group of runs. Then the receipt headline: every receipt but the fully
 * local study's, which the documents report on their own line beside it.
 */
const readme = readFileSync(resolveProjectPath("README.md"), "utf8");
const fact = (text: string, name: string) => new RegExp(`<!--fact:${name}-->(.*?)<!--/fact-->`).exec(text)?.[1];
const json = <T>(rel: string): T => JSON.parse(readFileSync(resolveProjectPath(rel), "utf8")) as T;
const stats = json<{ groups: Array<{ id: string; runs: number }> }>("eval/receipt-stats.json").groups;
const runsOf = (id: string) => stats.find((g) => g.id === id)?.runs;
const check = json<ReceiptScan>("eval/receipts-check.json");
const n = (x: number) => x.toLocaleString("en-US");

describe("the split of the exported runs in the README", () => {
  const text = fact(readme, "exported_split") ?? "";
  const parts =
    /^(\d+) recorded evaluation runs, plus (\d+) current-system runs and (\d+) Nemotron-alone study runs, make the (\d+) exported runs$/.exec(
      text,
    );

  it("is one sentence whose three groups add up to the exported runs", () => {
    expect(parts, text).not.toBeNull();
    const [recorded, current, alone, total] = (parts ?? []).slice(1).map(Number);
    expect((recorded ?? 0) + (current ?? 0) + (alone ?? 0)).toBe(total);
  });

  it("counts each group as the receipt statistics do, and the total as the receipt check does", () => {
    const [recorded, current, alone, total] = (parts ?? []).slice(1).map(Number);
    expect(RUN_GROUP_ORDER).toEqual(["recorded", "current-system", "nemotron-alone"]);
    expect([recorded, current, alone]).toEqual(RUN_GROUP_ORDER.map(runsOf));
    expect(total).toBe(check.groups.runs.folders);
  });

  it("states the recorded runs by the same count wherever the documents quote it", () => {
    const recorded = String(runsOf("recorded"));
    expect(fact(readme, "recorded_runs")).toBe(recorded);
    expect(fact(readFileSync(resolveProjectPath("docs/NEMOTRON.md"), "utf8"), "recorded_runs")).toBe(recorded);
  });
});

describe("the receipt headline and the fully local study's own line", () => {
  it("verify every committed receipt, and split the headline from the fully local study's receipts", () => {
    expect(check.valid_pinned).toBe(check.receipts);
    expect(check.headline + check.from_local_mode).toBe(check.receipts);
    expect(check.from_runs + check.from_studies + check.from_elsewhere).toBe(check.headline);
    expect(check.groups.local_mode.receipts).toBe(check.from_local_mode);
    expect(check.groups.local_mode.valid_pinned).toBe(check.from_local_mode);
    for (const f of check.per_file)
      expect(f.file.startsWith("eval/studies/local-mode/"), f.file).toBe(
        /heldout4-sys\d+-(lightning|routed)-a3-(local|default)-r\d+-/.test(f.file),
      );
  });

  it("quote the headline, not the grand total, wherever the documents and the site count receipts", () => {
    const docs = {
      "docs/MODELS.md": "receipts",
      "site/index.html": "receipts",
    };
    for (const [file, name] of Object.entries(docs))
      expect(fact(readFileSync(resolveProjectPath(file), "utf8"), name), file).toBe(n(check.headline));
    expect(fact(readme, "receipt_figure")).toContain(
      `The small studies add ${n(check.from_studies)} more signed receipts`,
    );
  });

  it("give the fully local study's receipts their own line beside every headline", () => {
    const line = localModeLine(check);
    expect(line).toBe(
      `Fully local study (A3): ${n(check.from_local_mode)} signed receipts, all verified against the pinned key.`,
    );
    for (const file of ["README.md", "docs/MODELS.md", "docs/NEMOTRON.md", "site/index.html"])
      expect(fact(readFileSync(resolveProjectPath(file), "utf8"), "receipts_local_mode_line"), file).toBe(line);
    // The scorecard's Receipts line and the receipt-statistics block carry it after the one receipt figure.
    const nemotron = readFileSync(resolveProjectPath("docs/NEMOTRON.md"), "utf8");
    expect(nemotron.match(new RegExp(`all verified\\.(\\*\\*)? ${line.replace(/[()]/g, "\\$&")}`, "g"))?.length).toBe(
      2,
    );
    expect(readFileSync(resolveProjectPath("eval/PROVE.md"), "utf8")).toContain(`${receiptsLine(check)}. ${line}`);
    expect(readme).toContain(`${receiptsLine(check)}. ${line}`);
  });

  it("word both lines from the counts, and say when a receipt does not verify or the study has none yet", () => {
    const r = {
      receipts: 10,
      headline: 7,
      from_runs: 5,
      from_studies: 2,
      from_local_mode: 3,
      valid_pinned: 10,
      groups: { local_mode: { valid_pinned: 3 } },
    };
    expect(receiptsLine(r)).toBe(
      "7 signed receipts: 5 from exported runs, 2 from studies, all verified against the pinned key",
    );
    expect(receiptsLine({ ...r, valid_pinned: 9 })).toBe(
      "7 signed receipts: 5 from exported runs, 2 from studies, 9 verified against the pinned key",
    );
    expect(localModeLine(r)).toBe("Fully local study (A3): 3 signed receipts, all verified against the pinned key.");
    expect(localModeLine({ ...r, groups: { local_mode: { valid_pinned: 2 } } })).toBe(
      "Fully local study (A3): 3 signed receipts, 2 verified against the pinned key.",
    );
    expect(localModeLine({ ...r, from_local_mode: 0 })).toBe("Fully local study (A3): no receipts exported yet.");
  });
});

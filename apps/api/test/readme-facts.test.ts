import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { RUN_GROUP_ORDER } from "../../../tools/lib/run-groups.js";

/**
 * The run counts the README states as facts (npm run readme:refresh writes them; CI checks they are current). Here the
 * sentence that splits the exported runs is read back: its numbers add up, and each is the count the receipt
 * statistics and the receipt check hold for that group of runs.
 */
const readme = readFileSync(resolveProjectPath("README.md"), "utf8");
const fact = (text: string, name: string) => new RegExp(`<!--fact:${name}-->(.*?)<!--/fact-->`).exec(text)?.[1];
const json = <T>(rel: string): T => JSON.parse(readFileSync(resolveProjectPath(rel), "utf8")) as T;
const stats = json<{ groups: Array<{ id: string; runs: number }> }>("eval/receipt-stats.json").groups;
const runsOf = (id: string) => stats.find((g) => g.id === id)?.runs;

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
    const check = json<{ groups: { runs: { folders: number } } }>("eval/receipts-check.json");
    expect(total).toBe(check.groups.runs.folders);
  });

  it("states the recorded runs by the same count wherever the documents quote it", () => {
    const recorded = String(runsOf("recorded"));
    expect(fact(readme, "recorded_runs")).toBe(recorded);
    expect(fact(readFileSync(resolveProjectPath("docs/NEMOTRON.md"), "utf8"), "recorded_runs")).toBe(recorded);
  });
});

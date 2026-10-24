import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  buildBank,
  ExamCaseSchema,
  HELDOUT2_EXAM_FILE,
  loadExam,
  SYNTHETIC_TABLE_NAMES,
  writeBank,
  writeExam,
  writeHeldout,
  writeHeldout2,
} from "../src/index.js";
import { tempDir } from "./helpers.js";
import { loadSampleTables } from "./sample-helpers.js";

const SNAPSHOTS = (
  JSON.parse(readFileSync(resolveProjectPath("data/sample/manifest.json"), "utf8")) as {
    snapshots: Array<{ snapshot_id: string }>;
  }
).snapshots.map((s) => s.snapshot_id);
const bank = buildBank(loadSampleTables(), SNAPSHOTS);
const read = (path: string) => readFileSync(path, "utf8");

describe("the second held-out set and the files that already exist", () => {
  it("reproduces the committed data (main, first and second set rows), tables and cases byte for byte", () => {
    // The committed data/synthetic holds the rows of every held-out set, as loaded into the running bank.
    const dir = tempDir();
    writeBank(dir, bank, { includeHeldout3: true });
    for (const name of SYNTHETIC_TABLE_NAMES) {
      for (const ext of ["json", "csv"]) {
        expect(read(join(dir, `${name}.${ext}`)), `${name}.${ext}`).toBe(
          read(resolveProjectPath(`data/synthetic/${name}.${ext}`)),
        );
      }
    }
    for (const file of ["list-delta.json", "manifest.json"]) {
      expect(read(join(dir, file)), file).toBe(read(resolveProjectPath(`data/synthetic/${file}`)));
    }
    writeExam(join(dir, "exam.json"), bank);
    writeHeldout(join(dir, "heldout.json"), bank);
    expect(read(join(dir, "exam.json"))).toBe(read(resolveProjectPath("eval/cases/exam.json")));
    expect(read(join(dir, "heldout.json"))).toBe(read(resolveProjectPath("eval/cases/heldout.json")));
  });

  it("without the flags writes the main rows only: the committed rows minus both held-out sets'", () => {
    const dir = tempDir();
    writeBank(dir, bank);
    for (const name of SYNTHETIC_TABLE_NAMES) {
      const committed = JSON.parse(read(resolveProjectPath(`data/synthetic/${name}.json`))) as Array<
        Record<string, string>
      >;
      const withoutHeldout = committed.filter((r) => !Object.values(r)[0]?.match(/^[A-Z]+-[HJK]\d/));
      expect(JSON.parse(read(join(dir, `${name}.json`))), name).toEqual(withoutHeldout);
    }
  });

  it("puts the second set's rows after the first set's when asked, and changes no earlier row", () => {
    const dir = tempDir();
    writeBank(dir, bank, { includeHeldout: true });
    const dir2 = tempDir();
    writeBank(dir2, bank, { includeHeldout2: true });
    let added = 0;
    for (const name of SYNTHETIC_TABLE_NAMES) {
      const v1 = JSON.parse(read(join(dir, `${name}.json`))) as unknown[];
      const v2 = JSON.parse(read(join(dir2, `${name}.json`))) as Array<Record<string, string>>;
      expect(v2.slice(0, v1.length), name).toEqual(v1);
      const extra = v2.slice(v1.length);
      added += extra.length;
      for (const row of extra) expect(Object.values(row)[0], name).toMatch(/^[A-Z]+-J\d/);
    }
    expect(added).toBeGreaterThan(30);
  });

  it("builds the same second set every time, from its own seed and without reusing a first-set listed party", () => {
    const again = buildBank(loadSampleTables(), SNAPSHOTS);
    expect(JSON.stringify(again.heldout2)).toBe(JSON.stringify(bank.heldout2));
    expect(JSON.stringify(again.tablesWithHeldout2)).toBe(JSON.stringify(bank.tablesWithHeldout2));
    const first = new Set(bank.heldout.map((c) => c.entry_id));
    for (const c of bank.heldout2) expect(first.has(c.entry_id), c.case_id).toBe(false);
  });

  it("matches the committed case file", () => {
    const dir = tempDir();
    writeHeldout2(join(dir, "heldout2.json"), bank);
    expect(read(join(dir, "heldout2.json"))).toBe(read(resolveProjectPath(HELDOUT2_EXAM_FILE)));
  });
});

describe("the exam loader and the HO2 ids", () => {
  it("accepts the second held-out file", () => {
    const exam = loadExam(HELDOUT2_EXAM_FILE);
    expect(exam.cases.map((c) => c.case_id)).toEqual(bank.heldout2.map((c) => c.case_id));
    expect(new Set(exam.cases.map((c) => c.group))).toEqual(new Set(["beyond_rules_v2"]));
  });

  it("still rejects ids and groups it does not know", () => {
    const good = bank.heldout2[0];
    expect(ExamCaseSchema.safeParse({ ...good, case_id: "HO5-001" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse({ ...good, case_id: "HO2-01" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse({ ...good, group: "beyond_rules_v5" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse(good).success).toBe(true);
  });
});

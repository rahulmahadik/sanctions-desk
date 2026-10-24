import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  buildBank,
  ExamCaseSchema,
  HELDOUT3_EXAM_FILE,
  loadExam,
  SYNTHETIC_TABLE_NAMES,
  writeBank,
  writeExam,
  writeHeldout,
  writeHeldout2,
  writeHeldout3,
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

describe("the third held-out set and the files that already exist", () => {
  it("reproduces the committed data (every set's rows, as loaded into the running bank) and the case files", () => {
    // The committed data/synthetic holds the main rows and all three held-out sets' rows.
    const dir = tempDir();
    writeBank(dir, bank, { includeHeldout4: true });
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
    writeHeldout2(join(dir, "heldout2.json"), bank);
    writeHeldout3(join(dir, "heldout3.json"), bank);
    for (const file of ["exam.json", "heldout.json", "heldout2.json", "heldout3.json"]) {
      expect(read(join(dir, file)), file).toBe(read(resolveProjectPath(`eval/cases/${file}`)));
    }
  });

  it("without any flag writes the main rows only: the committed rows minus every held-out set's", () => {
    const dir = tempDir();
    writeBank(dir, bank);
    for (const name of SYNTHETIC_TABLE_NAMES) {
      const committed = JSON.parse(read(resolveProjectPath(`data/synthetic/${name}.json`))) as Array<
        Record<string, string>
      >;
      const main = committed.filter((r) => !Object.values(r)[0]?.match(/^[A-Z]+-[HJKL]\d/));
      expect(JSON.parse(read(join(dir, `${name}.json`))), name).toEqual(main);
    }
  });

  it("puts the third set's rows after the second set's when asked, and changes no earlier row", () => {
    const dir2 = tempDir();
    writeBank(dir2, bank, { includeHeldout2: true });
    const dir3 = tempDir();
    writeBank(dir3, bank, { includeHeldout3: true });
    let added = 0;
    for (const name of SYNTHETIC_TABLE_NAMES) {
      const v2 = JSON.parse(read(join(dir2, `${name}.json`))) as unknown[];
      const v3 = JSON.parse(read(join(dir3, `${name}.json`))) as Array<Record<string, string>>;
      expect(v3.slice(0, v2.length), name).toEqual(v2);
      const extra = v3.slice(v2.length);
      added += extra.length;
      for (const row of extra) expect(Object.values(row)[0], name).toMatch(/^[A-Z]+-K\d/);
    }
    expect(added).toBeGreaterThan(30);
  });

  it("builds the same third set every time, from its own seed and without reusing an earlier set's listed party", () => {
    const again = buildBank(loadSampleTables(), SNAPSHOTS);
    expect(JSON.stringify(again.heldout3)).toBe(JSON.stringify(bank.heldout3));
    expect(JSON.stringify(again.tablesWithHeldout3)).toBe(JSON.stringify(bank.tablesWithHeldout3));
    const earlier = new Set([...bank.heldout, ...bank.heldout2].map((c) => c.entry_id));
    for (const c of bank.heldout3) expect(earlier.has(c.entry_id), c.case_id).toBe(false);
    expect(new Set(bank.heldout3.map((c) => c.entry_id)).size).toBe(bank.heldout3.length);
  });

  it("matches the committed case file", () => {
    const dir = tempDir();
    writeHeldout3(join(dir, "heldout3.json"), bank);
    expect(read(join(dir, "heldout3.json"))).toBe(read(resolveProjectPath(HELDOUT3_EXAM_FILE)));
  });
});

describe("the exam loader and the HO3 ids", () => {
  it("accepts the third held-out file", () => {
    const exam = loadExam(HELDOUT3_EXAM_FILE);
    expect(exam.cases.map((c) => c.case_id)).toEqual(bank.heldout3.map((c) => c.case_id));
    expect(new Set(exam.cases.map((c) => c.group))).toEqual(new Set(["beyond_rules_v3"]));
  });

  it("still rejects ids and groups it does not know", () => {
    const good = bank.heldout3[0];
    expect(ExamCaseSchema.safeParse({ ...good, case_id: "HO5-001" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse({ ...good, case_id: "HO3-01" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse({ ...good, group: "beyond_rules_v5" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse(good).success).toBe(true);
  });
});

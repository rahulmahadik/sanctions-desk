import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import {
  buildBank,
  ExamCaseSchema,
  HELDOUT4_EXAM_FILE,
  loadExam,
  SYNTHETIC_TABLE_NAMES,
  writeBank,
  writeExam,
  writeHeldout,
  writeHeldout2,
  writeHeldout3,
  writeHeldout4,
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

describe("the fourth held-out set and the files that already exist", () => {
  it("reproduces the committed data (every set's rows, as loaded into the running bank) and the case files", () => {
    // The committed data/synthetic holds the main rows and all four held-out sets' rows.
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
    writeHeldout4(join(dir, "heldout4.json"), bank);
    for (const file of ["exam.json", "heldout.json", "heldout2.json", "heldout3.json", "heldout4.json"]) {
      expect(read(join(dir, file)), file).toBe(read(resolveProjectPath(`eval/cases/${file}`)));
    }
  });

  it("puts the fourth set's rows after the third set's when asked, and changes no earlier row", () => {
    const dir3 = tempDir();
    writeBank(dir3, bank, { includeHeldout3: true });
    const dir4 = tempDir();
    writeBank(dir4, bank, { includeHeldout4: true });
    let added = 0;
    for (const name of SYNTHETIC_TABLE_NAMES) {
      const v3 = JSON.parse(read(join(dir3, `${name}.json`))) as unknown[];
      const v4 = JSON.parse(read(join(dir4, `${name}.json`))) as Array<Record<string, string>>;
      expect(v4.slice(0, v3.length), name).toEqual(v3);
      const extra = v4.slice(v3.length);
      added += extra.length;
      for (const row of extra) expect(Object.values(row)[0], name).toMatch(/^[A-Z]+-L\d/);
    }
    expect(added).toBeGreaterThan(40);
    for (const file of ["list-delta.json", "manifest.json"]) {
      expect(read(join(dir4, file)), file).toBe(read(join(dir3, file)));
    }
  });

  it("builds the same fourth set every time, without reusing a listed party of the main exam or an earlier set", () => {
    const again = buildBank(loadSampleTables(), SNAPSHOTS);
    expect(JSON.stringify(again.heldout4)).toBe(JSON.stringify(bank.heldout4));
    expect(JSON.stringify(again.tablesWithHeldout4)).toBe(JSON.stringify(bank.tablesWithHeldout4));
    const earlier = new Set(
      [...bank.cases, ...bank.heldout, ...bank.heldout2, ...bank.heldout3].map((c) => c.entry_id),
    );
    for (const c of bank.heldout4) expect(earlier.has(c.entry_id), c.case_id).toBe(false);
    expect(new Set(bank.heldout4.map((c) => c.entry_id)).size).toBe(bank.heldout4.length);
  });

  it("is built for the default seed only, like the third set", () => {
    const other = buildBank(loadSampleTables(), SNAPSHOTS, {
      seed: "another-seed",
      backgroundCustomers: 20,
      backgroundAlertThreshold: 0.9,
      maxBackgroundAlerts: 2,
    });
    expect(other.heldout4).toEqual([]);
    expect(other.tablesWithHeldout4).toEqual(other.tablesWithHeldout3);
  });

  it("matches the committed case file", () => {
    const dir = tempDir();
    writeHeldout4(join(dir, "heldout4.json"), bank);
    expect(read(join(dir, "heldout4.json"))).toBe(read(resolveProjectPath(HELDOUT4_EXAM_FILE)));
  });
});

describe("the exam loader and the HO4 ids", () => {
  it("accepts the fourth held-out file", () => {
    const exam = loadExam(HELDOUT4_EXAM_FILE);
    expect(exam.cases.map((c) => c.case_id)).toEqual(bank.heldout4.map((c) => c.case_id));
    expect(new Set(exam.cases.map((c) => c.group))).toEqual(new Set(["beyond_rules_v4"]));
  });

  it("still rejects ids and groups it does not know", () => {
    const good = bank.heldout4[0];
    expect(ExamCaseSchema.safeParse({ ...good, case_id: "HO5-001" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse({ ...good, case_id: "HO4-01" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse({ ...good, group: "beyond_rules_v5" }).success).toBe(false);
    expect(ExamCaseSchema.safeParse(good).success).toBe(true);
  });
});

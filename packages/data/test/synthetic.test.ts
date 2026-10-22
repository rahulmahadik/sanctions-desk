import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_THRESHOLD,
  buildSliceBank,
  candidatesFrom,
  createRng,
  nameVariant,
  planScenarios,
  SLICE_PLAN,
  type SliceBank,
  SYNTHETIC_LABEL,
  writeSliceBank,
} from "../src/index.js";
import { tempDir } from "./helpers.js";
import { loadSampleTables } from "./sample-helpers.js";

const T = { nameSimilarity: 0.85 };

describe("createRng", () => {
  it("repeats for the same seed and differs for another", () => {
    const a = createRng("x");
    const b = createRng("x");
    const c = createRng("y");
    const seqA = [a.next(), a.next(), a.int(1, 10)];
    expect(seqA).toEqual([b.next(), b.next(), b.int(1, 10)]);
    expect(seqA).not.toEqual([c.next(), c.next(), c.int(1, 10)]);
  });
  it("picks, shuffles and rejects empty picks", () => {
    const r = createRng("s");
    expect(["a", "b", "c"]).toContain(r.pick(["a", "b", "c"]));
    expect(r.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    expect(() => r.pick([])).toThrow(RangeError);
    expect(typeof r.chance(0.5)).toBe("boolean");
  });
});

describe("nameVariant", () => {
  it("changes the spelling and keeps the capitalisation style", () => {
    expect(nameVariant("Mohammed Al Hussein")).toBe("Muhammad Al Hussein");
    expect(nameVariant("IVAN PETROV")).toBe("IVAN PETRoV".toUpperCase().replace("PETROV", "PETROFF"));
    expect(nameVariant("Alex Brown Smith")).toBe("Alex Smith");
    expect(nameVariant("Bo")).not.toBe("Bo");
  });
});

describe("slice bank", () => {
  const sample = loadSampleTables();
  const bank: SliceBank = buildSliceBank(sample, "test-seed", T);

  it("is deterministic for a seed and changes with another", () => {
    expect(buildSliceBank(sample, "test-seed", T)).toEqual(bank);
    expect(buildSliceBank(sample, "other-seed", T).tables.customer).not.toEqual(bank.tables.customer);
  });

  it("covers every planned scenario with one labelled alert each", () => {
    const planned = SLICE_PLAN.reduce((n, p) => n + p.count, 0);
    expect(bank.cases).toHaveLength(planned);
    expect(bank.tables.alert).toHaveLength(planned);
    expect(new Set(bank.cases.map((c) => c.scenario))).toEqual(new Set(SLICE_PLAN.map((p) => p.kind)));
    expect(new Set(bank.cases.map((c) => c.source_entry_id)).size).toBe(planned);
  });

  it("raises each alert against the listed party the case is about", () => {
    for (const c of bank.cases) {
      const alert = bank.tables.alert.find((a) => a.alert_id === c.alert_id);
      expect(alert?.entry_id, c.scenario).toBe(c.entry_id);
      if (c.scenario !== "false_positive_surname") expect(c.entry_id, c.scenario).toBe(c.source_entry_id);
      expect(Number(alert?.match_score)).toBeGreaterThanOrEqual(ALERT_THRESHOLD);
    }
  });

  it("labels everything synthetic and plants the edge cases", () => {
    expect(bank.manifest.label).toBe(SYNTHETIC_LABEL);
    expect(bank.tables.customer.every((c) => c.data_origin === "synthetic")).toBe(true);
    expect(bank.tables.customer.some((c) => c.date_of_birth === null)).toBe(true);
    expect(bank.tables.customer.some((c) => c.date_of_birth !== null && c.date_of_birth.length === 4)).toBe(true);
    expect(bank.tables.customer.some((c) => c.customer_type === "company")).toBe(true);
    expect(
      bank.tables.customer.some((c) => /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(c.full_name)),
    ).toBe(true);
    expect(bank.tables.customer_identifier).toHaveLength(1);
  });

  it("writes the tables, the labels and a manifest", () => {
    const dir = writeSliceBank(tempDir(), bank);
    expect(JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))).toHaveLength(bank.cases.length);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).counts.alert).toBe(bank.cases.length);
    expect(JSON.parse(readFileSync(join(dir, "customer.json"), "utf8"))).toHaveLength(bank.tables.customer.length);
  });

  it("skips a scenario when no listed party fits and never reuses a party", () => {
    const rng = createRng("p");
    const candidates = candidatesFrom(sample);
    const plans = planScenarios(
      candidates,
      [
        { kind: "true_match_exact", count: 3 },
        { kind: "missing_dob", count: 3 },
      ],
      rng,
      "p",
    );
    expect(new Set(plans.map((p) => p.entry_id)).size).toBe(plans.length);
    const none = planScenarios([], [{ kind: "true_match_exact", count: 2 }], rng, "p");
    expect(none).toEqual([]);
  });
});

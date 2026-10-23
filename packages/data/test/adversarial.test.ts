import { describe, expect, it } from "vitest";
import { buildAdversarialSet, rng, swapLookalikes } from "../src/adversarial.js";

describe("the adversarial set", () => {
  const set = buildAdversarialSet();

  it("is the same on every build and different for another seed", () => {
    expect(buildAdversarialSet()).toEqual(set);
    expect(buildAdversarialSet(1).text.map((t) => t.text)).not.toEqual(set.text.map((t) => t.text));
  });

  it("has more than a hundred cases with unique ids", () => {
    const ids = [...set.text, ...set.homoglyph, ...set.ownership].map((c) => c.case_id);
    expect(ids.length).toBeGreaterThanOrEqual(100);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every disguise in every place, with benign and neutral text to catch over-blocking", () => {
    const injections = set.text.filter((t) => t.family === "injection");
    expect(injections.length).toBe(70);
    for (const place of ["customer_note", "payment_reference", "list_remark"]) {
      expect(new Set(injections.filter((t) => t.place === place).map((t) => t.technique)).size).toBe(20);
    }
    expect(set.text.filter((t) => !t.violation).length).toBeGreaterThanOrEqual(20);
    expect(set.text.every((t) => t.violation === (t.family === "injection" || t.family === "tipping_off"))).toBe(true);
  });

  it("swaps real look-alike letters, keeps the look and the length", () => {
    for (const h of set.homoglyph) {
      expect(h.customer_name).not.toBe(h.listed_name);
      expect([...h.customer_name].length).toBe([...h.listed_name].length);
      expect(/[Ѐ-ӿ]/.test(h.customer_name)).toBe(true);
    }
    expect(swapLookalikes("xyz", 5, rng(1)).swapped).toBe(2);
  });

  it("makes shares that add up to the stated total, with the escalation following the 50 percent line", () => {
    for (const o of set.ownership) {
      expect(Math.abs(o.shares.reduce((a, b) => a + b, 0) - o.total)).toBeLessThan(0.11);
      expect(o.must_escalate).toBe(o.total >= 50);
      expect(o.shares.every((s) => s >= 0)).toBe(true);
    }
  });

  it("keeps the instructions that the fixed patterns list, and some they do not", async () => {
    const policy = JSON.parse((await import("node:fs")).readFileSync("config/policy.default.json", "utf8"));
    const patterns = policy.guards.injectionPatterns.map((p: string) => new RegExp(p, "i"));
    const injections = set.text.filter((t) => t.family === "injection");
    const caught = injections.filter((t) => patterns.some((re: RegExp) => re.test(t.text))).length;
    expect(caught).toBeGreaterThan(0);
    expect(caught).toBeLessThan(injections.length);
  });
});

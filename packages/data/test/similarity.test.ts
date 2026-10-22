import { describe, expect, it } from "vitest";
import { jaroWinkler, nameScore, phoneticSkeleton, tokensOf } from "../src/matching/similarity.js";

describe("jaroWinkler", () => {
  it("is 1 for equal text, 0 for empty or disjoint text", () => {
    expect(jaroWinkler("martha", "martha")).toBe(1);
    expect(jaroWinkler("", "")).toBe(0);
    expect(jaroWinkler("abc", "")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
  it("matches the textbook values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.813, 3);
  });
});

describe("tokensOf and phoneticSkeleton", () => {
  it("splits on single spaces and drops empties", () => {
    expect(tokensOf("a  b ")).toEqual(["a", "b"]);
  });
  it("gives spelling variants of one sound the same skeleton", () => {
    expect(phoneticSkeleton("mohammed")).toBe(phoneticSkeleton("muhammad"));
    expect(phoneticSkeleton("hussein")).toBe(phoneticSkeleton("husayn"));
    expect(phoneticSkeleton("hussein")).not.toBe(phoneticSkeleton("ibrahim"));
  });
});

describe("nameScore", () => {
  it("scores identical names (after folding) as exact", () => {
    expect(nameScore("José  NÚÑEZ", "jose nunez")).toEqual({ score: 1, method: "exact" });
  });
  it("treats reordered tokens as a near-exact match", () => {
    expect(nameScore("Ivanov Petr", "Petr Ivanov")).toEqual({ score: 0.98, method: "token_set" });
  });
  it("recognises transliteration variants", () => {
    const r = nameScore("Mohammed Al Hussein", "Muhammad Al Husayn");
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.method).toBe("phonetic");
  });
  it("scores a shared surname with a different given name low", () => {
    expect(nameScore("Anna Petrova", "Dmitri Petrova").score).toBeLessThan(0.85);
  });
  it("lowers the score for extra tokens but not to zero", () => {
    const r = nameScore("Ali Hassan", "Ali Hassan Mahmoud Saleh");
    expect(r.score).toBeGreaterThan(0.8);
    expect(r.score).toBeLessThan(1);
  });
  it("returns none for empty input", () => {
    expect(nameScore("", "x")).toEqual({ score: 0, method: "none" });
  });
});

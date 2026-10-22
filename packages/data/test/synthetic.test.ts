import { describe, expect, it } from "vitest";
import { createRng, nameVariant } from "../src/index.js";

const _T = { nameSimilarity: 0.85 };

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

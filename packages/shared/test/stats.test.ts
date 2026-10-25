import { describe, expect, it } from "vitest";
import { countWithInterval, median, percentile, wilson95 } from "../src/index.js";

describe("percentile and median", () => {
  it("take the nearest-rank value, the lower middle one for an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(median([])).toBe(0);
  });
});

describe("wilson95", () => {
  it("matches the Wilson score interval, and is not zero-width at 0 of n", () => {
    expect(wilson95(0, 43)).toEqual({ low: 0, high: 8 });
    expect(wilson95(4, 48)).toEqual({ low: 3, high: 20 });
    expect(wilson95(4, 34)).toEqual({ low: 5, high: 27 });
    expect(wilson95(6, 6)).toEqual({ low: 61, high: 100 });
    expect(wilson95(0, 0)).toEqual({ low: 0, high: 100 });
  });

  it("writes a count with its interval", () => {
    expect(countWithInterval(0, 43)).toBe("0 of 43 (0–8%)");
  });
});

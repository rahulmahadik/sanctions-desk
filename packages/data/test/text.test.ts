import { describe, expect, it } from "vitest";
import {
  datesCompatible,
  daysInMonth,
  describeWindow,
  detectScript,
  isoDay,
  normaliseName,
  scriptsIn,
  windowOfIso,
} from "../src/text.js";

describe("normaliseName", () => {
  it("removes diacritics, case and punctuation", () => {
    expect(normaliseName("José  María O'Brien-Müller")).toBe("jose maria o brien muller");
    expect(normaliseName("  ŁUKASZ   Kowalski ")).toBe("lukasz kowalski");
    expect(normaliseName("Søren Bjørn Straße Æsir")).toBe("soren bjorn strasse aesir");
    expect(normaliseName("Đorđe Þór")).toBe("dorde thor");
    expect(normaliseName("Al-Rashid, Muhammad")).toBe("al rashid muhammad");
  });

  it("keeps letters of other scripts", () => {
    expect(normaliseName("Лукашэнка Александр")).toBe("лукашэнка александр");
    expect(normaliseName("محمد علي")).toBe("محمد علي");
    expect(normaliseName("习近平")).toBe("习近平");
  });

  it("returns an empty string for names with no letters", () => {
    expect(normaliseName(" --- ")).toBe("");
  });
});

describe("script detection", () => {
  it("finds the script of a name", () => {
    expect(detectScript("Mohammed Ali")).toBe("Latin");
    expect(detectScript("Лукашэнка")).toBe("Cyrillic");
    expect(detectScript("محمد")).toBe("Arabic");
    expect(detectScript("习近平")).toBe("Han");
    expect(detectScript("김정은")).toBe("Hangul");
    expect(detectScript("ひらがな")).toBe("Japanese");
    expect(detectScript("12345")).toBe("Latin");
  });

  it("reports a name that mixes scripts, the homoglyph signal", () => {
    const homoglyph = "Ivаn Petrov"; // the "а" is Cyrillic
    expect(homoglyph).not.toBe("Ivan Petrov");
    expect(detectScript(homoglyph)).toBe("Mixed");
    expect(scriptsIn(homoglyph)).toEqual(["Latin", "Cyrillic"]);
    expect(detectScript("Ivan Petrov")).toBe("Latin");
  });
});

describe("partial dates", () => {
  it("describes a single day, a month, a year and a range", () => {
    expect(describeWindow({ year: 1971, month: 3, day: 2 }, { year: 1971, month: 3, day: 2 })).toEqual({
      value: "1971-03-02",
      precision: "day",
      rangeFrom: null,
      rangeTo: null,
    });
    expect(describeWindow({ year: 1971, month: 2, day: 1 }, { year: 1971, month: 2, day: 28 })).toMatchObject({
      value: "1971-02",
      precision: "month",
    });
    expect(describeWindow({ year: 1951, month: 1, day: 1 }, { year: 1951, month: 12, day: 31 })).toMatchObject({
      value: "1951",
      precision: "year",
    });
    expect(describeWindow({ year: 1950, month: 1, day: 1 }, { year: 1953, month: 12, day: 31 })).toEqual({
      value: null,
      precision: "range",
      rangeFrom: "1950-01-01",
      rangeTo: "1953-12-31",
    });
  });

  it("knows month lengths, including leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2025, 12)).toBe(31);
    expect(isoDay(5, 1, 2)).toBe("0005-01-02");
  });

  it("turns an ISO value into the window of days it covers", () => {
    expect(windowOfIso("1971")).toEqual({
      from: { year: 1971, month: 1, day: 1 },
      to: { year: 1971, month: 12, day: 31 },
    });
    expect(windowOfIso("1971-02")?.to.day).toBe(28);
    expect(windowOfIso("1971-02-03")?.from).toEqual({ year: 1971, month: 2, day: 3 });
    for (const bad of ["1971-13", "1971-02-30", "71", "abc", "1971-1-1"]) expect(windowOfIso(bad), bad).toBeNull();
  });

  it("decides whether two partial dates can be the same day", () => {
    expect(datesCompatible("1971", "1971-05-03")).toBe(true);
    expect(datesCompatible("1971-05", "1971-05-31")).toBe(true);
    expect(datesCompatible("1971-05-03", "1971-05-04")).toBe(false);
    expect(datesCompatible("1971", "1972-01-01")).toBe(false);
    expect(datesCompatible("1971", "nope")).toBe(false);
  });
});

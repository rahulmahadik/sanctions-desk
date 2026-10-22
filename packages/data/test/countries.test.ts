import { describe, expect, it } from "vitest";
import { ISO_COUNTRIES, ISO2_CODES, isIso2, iso2FromName } from "../src/countries.js";

describe("country reference data", () => {
  it("lists every ISO 3166-1 alpha-2 code once", () => {
    expect(ISO_COUNTRIES).toHaveLength(249);
    expect(ISO2_CODES.size).toBe(249);
    for (const [code, name] of ISO_COUNTRIES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(name.length).toBeGreaterThan(1);
    }
  });

  it("validates codes", () => {
    expect(isIso2("GB")).toBe(true);
    expect(isIso2("gb")).toBe(false);
    expect(isIso2("UK")).toBe(false);
    expect(isIso2("XX")).toBe(false);
  });

  it("maps the names the lists use, including alternative spellings", () => {
    expect(iso2FromName("Russia")).toBe("RU");
    expect(iso2FromName("Russian Federation")).toBe("RU");
    expect(iso2FromName("Iran (Islamic Republic of)")).toBe("IR");
    expect(iso2FromName("Democratic People's Republic of Korea")).toBe("KP");
    expect(iso2FromName("Syrian Arab Republic")).toBe("SY");
    expect(iso2FromName("côte d'ivoire")).toBe("CI");
    expect(iso2FromName("  Burma ")).toBe("MM");
    expect(iso2FromName("Democratic Republic of the Congo")).toBe("CD");
    expect(iso2FromName("Atlantis")).toBeUndefined();
  });
});

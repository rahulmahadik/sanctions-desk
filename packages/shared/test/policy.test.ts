import { describe, expect, it } from "vitest";
import {
  AppError,
  loadPolicyFile,
  type Policy,
  parsePolicy,
  policyHash,
  policyRef,
  resolveProjectPath,
  validatePolicy,
} from "../src/index.js";
import { type Editor, policyJson, tempDir, writeJson } from "./helpers.js";

const edited = (edit: (e: Editor) => void): unknown => policyJson(edit);

const errorsFor = (input: unknown): string[] => {
  const result = validatePolicy(input);
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
};

describe("policy schema", () => {
  it("accepts the committed default policy", () => {
    const policy = loadPolicyFile("config/policy.default.json");
    expect(policy.version).toBe(2);
    expect(policy.evidenceStandard.requireCheckReference).toBe(true);
    expect(policy.ownership.thresholdPercent).toBe(50);
    expect(policy.lists.enabled).toEqual(["OFAC", "UN"]);
    expect(policy.jurisdictions.map((j) => j.country)).toEqual(["CU", "IR", "KP"]);
  });

  it("requires a positive whole version", () => {
    expect(errorsFor(edited((e) => e.remove("version")))).toContainEqual(expect.stringMatching(/^version:/));
    expect(errorsFor(edited((e) => e.set("version", 0)))).toContainEqual(expect.stringMatching(/^version:/));
    expect(errorsFor(edited((e) => e.set("version", 1.5)))).toContainEqual(expect.stringMatching(/^version:/));
  });

  it.each([
    ["automation.autoBlock", true],
    ["automation.messageCustomers", true],
    ["automation.dataAccess", "read_write"],
    ["automation.blockApprovalsRequired", 1],
    ["critic.abstainOnInvalidData", false],
    ["ownership.onLimitReached", "close"],
  ])("cannot relax the hard lock %s", (path, value) => {
    expect(errorsFor(edited((e) => e.set(path, value))).some((issue) => issue.startsWith(path))).toBe(true);
  });

  it("rejects thresholds that contradict each other", () => {
    expect(errorsFor(edited((e) => e.set("matching.autoCloseCeiling", 0.95)))).toContainEqual(
      expect.stringContaining("autoCloseCeiling must not exceed"),
    );
    expect(errorsFor(edited((e) => e.set("matching.minStrongIdentifierMatches", 9)))).toContainEqual(
      expect.stringContaining("cannot require more strong matches"),
    );
    expect(errorsFor(edited((e) => e.set("matching.strongIdentifierFields", ["dob", "dob"])))).toContainEqual(
      expect.stringContaining("must be unique"),
    );
  });

  it("validates ownership limits", () => {
    expect(errorsFor(edited((e) => e.set("ownership.thresholdPercent", 0)))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("ownership.thresholdPercent", 101)))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("ownership.maxChainDepth", 11)))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("ownership.thresholdPercent", 25)))).toEqual([]);
  });

  it("validates list settings", () => {
    expect(errorsFor(edited((e) => e.set("lists.enabled", [])))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("lists.enabled", ["OFAC", "OFAC"])))).toContainEqual(
      expect.stringContaining("unique"),
    );
    expect(errorsFor(edited((e) => e.set("lists.weights.UN", 0)))).toContainEqual(
      expect.stringContaining("weight above 0"),
    );
    expect(errorsFor(edited((e) => e.push("lists.enabled", "XX")))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.push("lists.enabled", "EU")))).toEqual([]);
  });

  it("validates jurisdictions", () => {
    expect(errorsFor(edited((e) => e.set("jurisdictions.0.country", "cuba")))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.push("jurisdictions", { country: "CU", action: "review" })))).toContainEqual(
      expect.stringContaining("may appear once"),
    );
    expect(errorsFor(edited((e) => e.set("jurisdictions.0.action", "ignore")))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("jurisdictions", [])))).toEqual([]);
  });

  it("limits critic rounds to 1 to 3", () => {
    expect(errorsFor(edited((e) => e.set("critic.maxRounds", 4)))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("critic.maxRounds", 0)))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("critic.maxRounds", 1)))).toEqual([]);
  });

  it("requires a model and a masking role for every agent", () => {
    expect(errorsFor(edited((e) => e.remove("models.critic")))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.remove("masking.reporter")))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("models.critic.thinking", "maybe")))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("models.critic.thinking", { budgetTokens: 512 })))).toEqual([]);
    expect(errorsFor(edited((e) => e.set("models.critic.timeoutMs", 0)))).not.toEqual([]);
  });

  it("rejects guard patterns that are not valid regular expressions", () => {
    expect(errorsFor(edited((e) => e.push("guards.injectionPatterns", "([unclosed")))).toContainEqual(
      expect.stringContaining("valid regular expression"),
    );
    expect(errorsFor(edited((e) => e.set("guards.injectionPatterns", [])))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("guards.tippingOffPolicy", "too short")))).not.toEqual([]);
  });

  it("rejects unknown keys so a typo cannot silently do nothing", () => {
    expect(errorsFor(edited((e) => e.set("matching.nameSimilarityTreshold", 0.5)))).not.toEqual([]);
    expect(errorsFor(edited((e) => e.set("surprise", true)))).not.toEqual([]);
  });

  it("reports issues with a dotted path for inline editor errors", () => {
    const result = validatePolicy(edited((e) => e.set("critic.maxRounds", 9)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((issue) => issue.path === "critic.maxRounds")).toBe(true);
  });

  it("parsePolicy throws a validation error carrying the issues", () => {
    let error: unknown;
    try {
      parsePolicy({});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).type).toBe("validation");
    expect(Array.isArray((error as AppError).details?.issues)).toBe(true);
  });
});

describe("policy hash and reference", () => {
  const base = (): Policy => parsePolicy(policyJson());

  it("is stable and ignores key order", () => {
    const original = policyJson();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(policyHash(parsePolicy(reordered))).toBe(policyHash(base()));
    expect(policyHash(base())).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when behaviour or version changes", () => {
    const changed = parsePolicy(policyJson((e) => e.set("ownership.thresholdPercent", 40)));
    expect(policyHash(changed)).not.toBe(policyHash(base()));
    const bumped = parsePolicy(policyJson((e) => e.set("version", 2)));
    expect(policyHash(bumped)).not.toBe(policyHash(base()));
    expect(policyRef(bumped)).toEqual({ version: 2, hash: policyHash(bumped) });
  });
});

describe("loadPolicyFile", () => {
  it("reports unreadable, malformed and invalid files", () => {
    const dir = tempDir();
    expect(() => loadPolicyFile(`${dir}/missing.json`)).toThrow(/cannot read policy file/);
    const malformed = writeJson(dir, "bad.json", "{");
    expect(() => loadPolicyFile(malformed)).toThrow(AppError);
    const invalid = writeJson(dir, "invalid.json", { version: 1 });
    expect(() => loadPolicyFile(invalid)).toThrow(/invalid policy/);
  });

  it("resolves relative paths from the repository root", () => {
    expect(resolveProjectPath("config/policy.default.json")).toMatch(/config\/policy\.default\.json$/);
    expect(resolveProjectPath("/abs/path.json")).toBe("/abs/path.json");
  });
});

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFile, fieldLine, type HashChange, sha256Hex } from "../../../tools/lib/hash-changes.js";
import { tempDir } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("a documented change to an exported file", () => {
  const original = `{\n  "features": {\n    ${fieldLine("commit", "aaaaaaa")}\n  },\n  "cases": []\n}\n`;
  const current = original.replace(fieldLine("commit", "aaaaaaa"), fieldLine("commit", "bbbbbbb"));
  const change: HashChange = {
    run: "r",
    file: "results.json",
    original_sha256: sha256Hex(original),
    current_sha256: sha256Hex(current),
    field: "commit",
    original_value: "aaaaaaa",
    current_value: "bbbbbbb",
  };

  it("passes a file that matches its manifest, and one whose only change is the documented field", () => {
    expect(checkFile(Buffer.from(original), sha256Hex(original), undefined)).toBe("match");
    expect(checkFile(Buffer.from(current), sha256Hex(original), change)).toBe("remapped");
  });

  it("fails any other difference, an undocumented change, or a wrong documented value", () => {
    const other = current.replace('"cases": []', '"cases": [1]');
    expect(checkFile(Buffer.from(other), sha256Hex(original), { ...change, current_sha256: sha256Hex(other) })).toBe(
      "differs",
    );
    expect(checkFile(Buffer.from(current), sha256Hex(original), undefined)).toBe("differs");
    expect(checkFile(Buffer.from(current), sha256Hex(original), { ...change, original_value: "ccccccc" })).toBe(
      "differs",
    );
  });
});

describe("evidence:verify on an exported run with a documented change", () => {
  const RUN = "routed-20261023T133311Z";
  const copy = () => {
    const runs = join(tempDir(), "runs");
    mkdirSync(runs, { recursive: true });
    cpSync(join(ROOT, "eval/runs", RUN), join(runs, RUN), { recursive: true });
    cpSync(join(ROOT, "eval/runs/HASH-CHANGES.json"), join(runs, "HASH-CHANGES.json"));
    return join(runs, RUN);
  };
  const verify = (dir: string) =>
    spawnSync("npx", ["tsx", "tools/evidence-verify.ts", dir], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

  it("reports the remapped file as verified, and fails when anything else in it changed", () => {
    const dir = copy();
    const ok = verify(dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("results.json verified, commit field remapped (documented)");
    const file = join(dir, "results.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"got": "', '"got": "X'));
    const bad = verify(dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("DIFFERS from its manifest hash");
  }, 240_000);
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("the README's real trace", () => {
  it("is exactly what the committed output example gives, never typed in", () => {
    const res = spawnSync("npx", ["tsx", "tools/real-trace.ts", "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});

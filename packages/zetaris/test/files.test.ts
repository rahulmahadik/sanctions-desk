import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CommandRunner, findFileStoreRoot, placeFiles } from "../src/files.js";

const ROOT = "/home/zetaris/customer-data/abc123/file-store";

function runner(stdout = `${ROOT}\n`): {
  run: CommandRunner;
  calls: Array<{ args: readonly string[]; input?: Buffer }>;
} {
  const calls: Array<{ args: readonly string[]; input?: Buffer }> = [];
  return {
    calls,
    run: async (_file, args, input) => {
      calls.push({ args, input });
      return { stdout: args.includes("-i") ? "" : stdout };
    },
  };
}

describe("findFileStoreRoot", () => {
  it("returns the single organisation file-store folder", async () => {
    const { run } = runner();
    expect(await findFileStoreRoot({ container: "c", folder: "sanctions", run })).toBe(ROOT);
  });
  it("fails when there is none or more than one", async () => {
    await expect(findFileStoreRoot({ container: "c", folder: "f", run: runner("").run })).rejects.toMatchObject({
      type: "config_missing",
    });
    await expect(
      findFileStoreRoot({ container: "c", folder: "f", run: runner(`${ROOT}\n${ROOT}2\n`).run }),
    ).rejects.toMatchObject({
      type: "config_missing",
    });
  });
});

describe("placeFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "zfiles-"));
  const file = join(dir, "list_entry.json");
  writeFileSync(file, '[{"a":1}]');

  it("writes each file into our own folder through the container, passing paths as arguments", async () => {
    const { run, calls } = runner();
    const placed = await placeFiles({ container: "c", folder: "sanctions", run }, [
      { localPath: file, subfolder: "sanctions_lists" },
    ]);
    expect(placed).toEqual([
      { localPath: file, remotePath: `${ROOT}/sanctions/sanctions_lists/list_entry.json`, bytes: 9 },
    ]);
    const write = calls[1];
    expect(write?.args).toEqual([
      "exec",
      "-i",
      "c",
      "sh",
      "-c",
      'mkdir -p "$1" && cat > "$2"',
      "sh",
      `${ROOT}/sanctions/sanctions_lists`,
      `${ROOT}/sanctions/sanctions_lists/list_entry.json`,
    ]);
    expect(write?.input?.toString()).toBe('[{"a":1}]');
  });

  it("refuses unsafe folder and file names", async () => {
    const { run } = runner();
    await expect(placeFiles({ container: "c", folder: "../x", run }, [])).rejects.toMatchObject({ type: "validation" });
    await expect(
      placeFiles({ container: "c", folder: "ok", run }, [{ localPath: file, subfolder: "a/b" }]),
    ).rejects.toMatchObject({
      type: "validation",
    });
    const odd = join(dir, "we ird.json");
    writeFileSync(odd, "[]");
    await expect(
      placeFiles({ container: "c", folder: "ok", run }, [{ localPath: odd, subfolder: "a" }]),
    ).rejects.toMatchObject({
      type: "validation",
    });
  });
});

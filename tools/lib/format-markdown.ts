/**
 * Format a Markdown file's text the way `npm run lint` expects (Biome), so a generator that writes a block into a
 * formatted doc leaves it as the formatter would, and its `--check` mode compares like with like. README.md and the
 * other files excluded from formatting in biome.json come back unchanged.
 */
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { projectRoot } from "@sanctions-desk/shared";

export function formatMarkdown(text: string, path: string): string {
  const root = projectRoot();
  const biome = join(root, "node_modules", ".bin", process.platform === "win32" ? "biome.cmd" : "biome");
  const res = spawnSync(biome, ["format", `--stdin-file-path=${relative(root, path)}`], {
    cwd: root,
    input: text,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0) throw new Error(`biome could not format ${relative(root, path)}: ${res.stderr || res.error}`);
  return res.stdout;
}

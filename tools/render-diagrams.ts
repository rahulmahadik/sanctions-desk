/**
 * Render every Mermaid diagram in docs/diagrams/*.mmd to an SVG beside it, with the shared theme
 * (docs/diagrams/mermaid.config.json) and a transparent background, so it reads on light and dark pages.
 *
 *   npm run diagrams                     every diagram
 *   npm run diagrams -- --png <folder>   also a PNG of each into that folder (to look at them)
 *
 * Uses @mermaid-js/mermaid-cli 11.4.2 through npx. Chrome is the one at --chrome <path>, or the usual macOS place;
 * nothing is downloaded when one is found.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPath } from "@sanctions-desk/shared";

const CLI = "@mermaid-js/mermaid-cli@11.4.2";
const dir = resolveProjectPath("docs/diagrams");
const png = process.argv.includes("--png") ? process.argv[process.argv.indexOf("--png") + 1] : undefined;
const chrome = process.argv.includes("--chrome")
  ? (process.argv[process.argv.indexOf("--chrome") + 1] as string)
  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const work = mkdtempSync(join(tmpdir(), "desk-diagrams-"));
const puppeteer = join(work, "puppeteer.json");
writeFileSync(puppeteer, JSON.stringify(existsSync(chrome) ? { executablePath: chrome, args: ["--no-sandbox"] } : {}));

let failed = 0;
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".mmd"))
  .sort()) {
  const outputs = [
    join(dir, file.replace(/\.mmd$/, ".svg")),
    ...(png ? [join(png, file.replace(/\.mmd$/, ".png"))] : []),
  ];
  for (const out of outputs) {
    const r = spawnSync(
      "npx",
      [
        "-y",
        CLI,
        "-p",
        puppeteer,
        "-c",
        join(dir, "mermaid.config.json"),
        "-b",
        "transparent",
        "-i",
        join(dir, file),
        "-o",
        out,
      ],
      { encoding: "utf8", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: existsSync(chrome) ? "1" : "" } },
    );
    if (r.status !== 0) {
      failed += 1;
      console.error(`${file}: ${(r.stderr || r.stdout).split("\n").slice(-4).join(" ")}`);
    } else console.log(`rendered ${out.replace(`${resolveProjectPath(".")}/`, "")}`);
  }
}
rmSync(work, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);

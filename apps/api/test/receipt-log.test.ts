import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { afterAll, describe, expect, it } from "vitest";
import { verifyExportedRun } from "../../../tools/lib/evidence.js";
import { baselinesLine, buildReceiptLog, loadRunLog, runDirs } from "../../../tools/lib/receipt-log.js";
import { RecordedRunError } from "../../../tools/lib/runs-site.js";

const out = mkdtempSync(join(tmpdir(), "desk-receipts-"));
const scratch = mkdtempSync(join(tmpdir(), "desk-receipts-tamper-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const written = buildReceiptLog(out);
const html = (f: string) => readFileSync(join(out, f), "utf8");
type Envelope = { body: { receipt?: { receipt_id?: string; prompt_preview?: string } } };
const envelopes = (dir: string): Envelope[] =>
  gunzipSync(readFileSync(join(dir, "receipts.jsonl.gz")))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Envelope);

/** The first 20 characters of each prompt preview a run's receipts carry. */
const previewStarts = (dir: string): string[] =>
  envelopes(dir)
    .map((env) => env.body.receipt?.prompt_preview?.trim() ?? "")
    .filter((p) => p.length >= 20)
    .map((p) => p.slice(0, 20));

describe("the receipt log", () => {
  it("has a page for every committed run, and an index that lists the runs with model calls", () => {
    const dirs = runDirs();
    expect(dirs.length).toBeGreaterThan(0);
    const index = html("index.html");
    let baselines = 0;
    for (const d of dirs) {
      const runId = d.split("/").at(-1) as string;
      expect(written).toContain(`${runId}.html`);
      if (loadRunLog(d).calls.length > 0) {
        expect(index).toContain(`href="${runId}.html"`);
      } else {
        // A baseline without a model: its row would be all zero, so it is counted in one line under the table.
        expect(runId, "a run with no model call").toMatch(/^(heldout\d?-)?(rules|fuzzy|escalate_all)-/);
        expect(index).not.toContain(`href="${runId}.html"`);
        baselines += 1;
      }
    }
    expect(baselines).toBeGreaterThan(0);
    expect(index).toContain(baselinesLine(baselines));
    expect(baselinesLine(15)).toBe(
      "Baselines without a model (rules, name matching, escalate everything): no model calls, so no receipts — 15 runs.",
    );
    expect(index).toContain('href="../site.css"');
    expect(written).not.toContain("receipts.css");
  });

  it("says who answered before the full list, and labels the Ollama backup as having no receipt by design", () => {
    const run = runDirs().find((d) => d.endsWith("routed-20261023T133311Z")) as string;
    const page = html(`${run.split("/").at(-1)}.html`);
    expect(page.indexOf("Who answered, in this run")).toBeGreaterThan(-1);
    expect(page.indexOf("Who answered, in this run")).toBeLessThan(page.indexOf("Every model call of the run"));
    expect(page).toContain("Local Ollama backup (Lightning)");
    expect(page).toContain("no receipt by design: the local Ollama backup answered");
  });

  it("counts the same verified receipts as npm run evidence:verify", () => {
    let fromVerify = 0;
    let fromLog = 0;
    for (const d of runDirs()) {
      fromVerify += verifyExportedRun(d, []).calls;
      fromLog += loadRunLog(d).verified;
    }
    expect(fromLog).toBe(fromVerify);
    expect(html("index.html")).toContain(`${fromLog.toLocaleString("en-US")} receipts verified`);
  });

  it("lists every receipt the trace names, and never the prompt text a receipt carries", () => {
    for (const d of runDirs()) {
      const log = loadRunLog(d);
      const page = html(`${log.runId}.html`);
      for (const c of log.calls) if (c.receipt) expect(page).toContain(c.receipt.id);
      for (const start of previewStarts(d)) expect(page).not.toContain(start);
    }
  });

  it("does not count the rules stand-in of a baseline as a model call", () => {
    const rules = runDirs().find((d) => /\/rules-/.test(d));
    expect(rules).toBeDefined();
    expect(loadRunLog(rules as string).calls).toHaveLength(0);
  });
});

describe("the receipt log build", () => {
  const run = runDirs().find((d) => d.endsWith("heldout4-sys4-routed-20261024T024523Z")) as string;
  const runId = run.split("/").at(-1) as string;
  const fresh = () => {
    const runs = mkdtempSync(join(scratch, "runs-"));
    cpSync(run, join(runs, runId), { recursive: true });
    cpSync(resolveProjectPath("eval/runs/HASH-CHANGES.json"), join(runs, "HASH-CHANGES.json"));
    return runs;
  };
  const rewriteReceipts = (runs: string, change: (lines: string[]) => string[]) => {
    const dir = join(runs, runId);
    const file = join(dir, "receipts.jsonl.gz");
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
    writeFileSync(file, gzipSync(`${change(lines).join("\n")}\n`));
    const meta = JSON.parse(readFileSync(join(dir, "run-meta.json"), "utf8"));
    meta.files["receipts.jsonl.gz"].sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    writeFileSync(join(dir, "run-meta.json"), JSON.stringify(meta));
  };
  const build = (runsDir: string) => () => buildReceiptLog(mkdtempSync(join(scratch, "out-")), { runsDir });
  const firstId = () => envelopes(run)[0]?.body.receipt?.receipt_id as string;

  it("builds from an untouched copy", () => {
    expect(build(fresh())()).toContain(`${runId}.html`);
  });

  it("fails when a receipt was changed after it was signed", () => {
    const runs = fresh();
    const id = firstId();
    rewriteReceipts(runs, (lines) =>
      lines.map((l) => {
        if (!l.includes(`"receipt_id":"${id}"`)) return l;
        const env = JSON.parse(l);
        env.body.receipt.app = "changed-after-signing";
        return JSON.stringify(env);
      }),
    );
    expect(build(runs)).toThrow(RecordedRunError);
  });

  it("fails when a receipt the trace names is missing", () => {
    const runs = fresh();
    const id = firstId();
    rewriteReceipts(runs, (lines) => lines.filter((l) => !l.includes(`"receipt_id":"${id}"`)));
    expect(build(runs)).toThrow(/is not in receipts\.jsonl\.gz/);
  });
});

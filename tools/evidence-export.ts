/**
 * Copy the final exam runs into eval/runs/<run-id>/ so anyone can check which model served each call without the
 * private logs. For each run: results.json, run-meta.json, trace.jsonl.gz and receipts.jsonl.gz. Tokens, local
 * paths, hostnames and addresses other than the local machine, usernames, e-mail addresses and the values of
 * secret environment variables are redacted from the results and the trace. The receipts are copied untouched
 * (their signatures cover their content); if one matches a redaction pattern the export stops.
 *
 *   npm run evidence:export                   the newest complete run of every variant, and the held-out run
 *   npm run evidence:export -- --only routed,single
 *
 * It fails when anything it wrote still matches a redaction pattern, and reports the size.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
// @ts-expect-error plain JavaScript module shared with the repository scan
import { matches, REDACTIONS } from "../scripts/redaction-patterns.mjs";
import { formatMarkdown } from "./lib/format-markdown.js";

const root = projectRoot();
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? (args[args.indexOf(n) + 1] as string) : undefined);
const logs = resolveProjectPath(flag("--logs-dir") ?? config.logging.dir);

const only = flag("--only")?.split(",");
const outRoot = resolveProjectPath(flag("--out") ?? "eval/runs");

// Values of secret environment variables must never appear in what is published.
const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD)/i;
const secretValues = Object.entries(process.env)
  .filter(([k, v]) => SECRET_NAME.test(k) && (v ?? "").length >= 8)
  .map(([, v]) => v as string);

const counts = new Map<string, number>();
/** The Nightshift build in force when a run started, from eval/nightshift-builds.json (null if not listed). */
function nightshiftBuildAt(startedAt: string): { version: string; source: string; known_limits: string[] } | null {
  const file = resolveProjectPath("eval/nightshift-builds.json");
  if (!existsSync(file)) return null;
  const { builds } = JSON.parse(readFileSync(file, "utf8")) as {
    builds: Array<{ version: string; source: string; from: string; until: string | null; known_limits: string[] }>;
  };
  const at = Date.parse(startedAt);
  const b = builds.find((x) => at >= Date.parse(x.from) && (x.until === null || at < Date.parse(x.until)));
  return b ? { version: b.version, source: b.source, known_limits: b.known_limits } : null;
}

function redact(text: string): string {
  let out = text.split(`${root}/`).join("");
  for (const value of secretValues) out = out.split(value).join("[redacted]");
  for (const r of REDACTIONS as Array<{ name: string; re: RegExp; with: string }>) {
    out = out.replace(r.re, () => {
      counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
      return r.with;
    });
  }
  return out;
}

interface Result {
  variant: string;
  tag?: string;
  exam?: string;
  /** The system version a later run was made with (its run ids carry it). */
  system?: string;
  selection?: { groups?: unknown; kinds?: unknown; limit?: unknown };
  started_at: string;
  finished_at: string;
  features?: unknown;
  policy_version: number;
  models: unknown;
  cases: Array<{ case_id: string }>;
}

const resultsDir = resolveProjectPath(flag("--results-dir") ?? "eval/results");
const complete = readdirSync(resultsDir)
  .filter((f) => f.endsWith(".json") && !f.startsWith("bench-"))
  .sort()
  .map((file) => ({ file, r: JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as Result }))
  .filter(({ r }) => !r.tag && !r.selection?.kinds && !r.selection?.groups && !r.selection?.limit);

// The newest complete run of each variant, and of each exam (the held-out set is its own exam).
const chosen = new Map<string, { file: string; r: Result }>();
// Runs whose system name marks a probe (a smoke test, an outage test) are not final runs and are left out.
const PROBES = new Set(["smoke", "zdown", "probe"]);
for (const run of complete) {
  if (run.r.system && PROBES.has(run.r.system)) continue;
  chosen.set(`${run.r.exam ?? "exam"}:${run.r.system ?? ""}:${run.r.variant}`, run);
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const idOf = (r: Result) =>
  `${r.exam && r.exam !== "exam" ? `${r.exam}-` : ""}${r.system ? `${r.system}-` : ""}${r.variant}-${r.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
const problems: string[] = [];
const summary: Array<{ id: string; bytes: number; receipts: number; events: number }> = [];

for (const { file, r } of chosen.values()) {
  if (only && !only.includes(r.variant)) continue;
  const id = idOf(r);
  const dir = join(outRoot, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // The trace: the events of the run's last attempt at each case, within the run's time window.
  const until = new Date(Date.parse(r.finished_at) + 60_000).toISOString();
  const lines: string[] = [];
  const receiptIds = new Set<string>();
  for (const c of r.cases) {
    const prefix = `${r.exam && r.exam !== "exam" ? `eval-${r.exam}` : "eval"}${r.system ? `-${r.system}` : ""}`;
    const name = join(logs, `trace-${prefix}-${r.variant}-${c.case_id}.jsonl`);
    if (!existsSync(name)) continue;
    const events = readFileSync(name, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { ts: string; seq: number; receipt?: { receipt_id?: string } })
      .filter((e) => e.ts >= r.started_at && e.ts <= until);
    const from = Math.max(0, events.map((e) => e.seq).lastIndexOf(0));
    for (const e of events.slice(from)) {
      if (e.receipt?.receipt_id) receiptIds.add(e.receipt.receipt_id);
      lines.push(redact(JSON.stringify({ case_id: c.case_id, ...e })));
    }
  }

  // The receipts: untouched, because the signature covers them. A match is a reason to stop, not to edit.
  const receiptLines: string[] = [];
  for (const rid of [...receiptIds].sort()) {
    const path = join(logs, "receipts", `${rid}.json`);
    if (!existsSync(path)) {
      problems.push(`${id}: receipt ${rid} is named in the trace but its file is missing`);
      continue;
    }
    const text = JSON.stringify(JSON.parse(readFileSync(path, "utf8")));
    const hit = matches(text);
    if (hit.length > 0) problems.push(`${id}: receipt ${rid} matches ${hit.join(", ")}; receipts cannot be edited`);
    receiptLines.push(text);
  }

  const resultsText = redact(readFileSync(join(resultsDir, file), "utf8"));
  const files: Record<string, Buffer | string> = {
    "results.json": resultsText,
    "trace.jsonl.gz": gzipSync(`${lines.join("\n")}\n`, { level: 9 }),
    "receipts.jsonl.gz": gzipSync(`${receiptLines.join("\n")}\n`, { level: 9 }),
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  const meta = {
    run_id: id,
    variant: r.variant,
    exam: r.exam ?? "exam",
    started_at: r.started_at,
    finished_at: r.finished_at,
    policy_version: r.policy_version,
    features: r.features ?? null,
    // How the Nightshift cockpit bound each app identity during the run (also inside features).
    nightshift_build: nightshiftBuildAt(r.started_at),
    app_binds: (r.features as { cockpit_binds?: Record<string, string> } | undefined)?.cockpit_binds ?? null,
    models: r.models,
    cases: r.cases.length,
    events: lines.length,
    receipts: receiptLines.length,
    files: Object.fromEntries(
      Object.entries(files).map(([n, d]) => [n, { bytes: Buffer.byteLength(d), sha256: sha(d) }]),
    ),
    redacted:
      "tokens, local paths, hostnames and addresses other than the local machine, usernames, e-mail addresses and secret environment values were removed from results.json and trace.jsonl.gz; receipts.jsonl.gz is untouched",
    verify: `npm run evidence:verify -- eval/runs/${id}`,
  };
  writeFileSync(join(dir, "run-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const bytes = readdirSync(dir).reduce((t, n) => t + statSync(join(dir, n)).size, 0);
  summary.push({ id, bytes, receipts: receiptLines.length, events: lines.length });
}

// Whatever was written must be clean.
for (const { id } of summary) {
  const dir = join(outRoot, id);
  for (const name of ["results.json", "trace.jsonl.gz", "receipts.jsonl.gz", "run-meta.json"]) {
    const raw = readFileSync(join(dir, name));
    const text = name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    const hit = matches(text);
    if (hit.length > 0) problems.push(`${id}/${name} still matches: ${hit.join(", ")}`);
    for (const value of secretValues)
      if (text.includes(value)) problems.push(`${id}/${name} still holds a secret value`);
  }
}

if (problems.length > 0) {
  console.error(`evidence export FAILED:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
// docs/MODELS.md links the receipt log of each exported run, with the command that checks it; only an export to the
// committed eval/runs does this, so an export to another folder (as the tests make) never rewrites the doc.
const docPath = resolveProjectPath("docs/MODELS.md");
const doc = readFileSync(docPath, "utf8");
const RS = "<!-- receipts:start -->";
const RE = "<!-- receipts:end -->";
const intoCommitted = outRoot === resolveProjectPath("eval/runs");
if (intoCommitted && doc.includes(RS) && doc.includes(RE) && summary.length > 0) {
  const block = [
    RS,
    "| Run | Receipts | Receipt log | Check it |",
    "| --- | ---: | --- | --- |",
    ...summary.map(
      (s) =>
        `| \`${s.id}\` | ${s.receipts} | [eval/runs/${s.id}/receipts.jsonl.gz](../eval/runs/${s.id}/receipts.jsonl.gz) | \`npm run evidence:verify -- eval/runs/${s.id}\` |`,
    ),
    "",
    "`npm run evidence:verify` with no argument checks every run: each signature, that every model call has a receipt, and that the model in the trace equals the model in the receipt.",
    RE,
  ].join("\n");
  writeFileSync(docPath, formatMarkdown(doc.replace(new RegExp(`${RS}[\\s\\S]*?${RE}`), block), docPath));
}
const total = summary.reduce((t, s) => t + s.bytes, 0);
for (const s of summary)
  console.log(
    `${s.id.padEnd(48)} ${String(s.events).padStart(6)} events ${String(s.receipts).padStart(5)} receipts ${(s.bytes / 1024).toFixed(0).padStart(6)} KiB`,
  );
console.log(
  `total ${(total / 1024 / 1024).toFixed(2)} MiB in ${summary.length} run(s); redactions made: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
);

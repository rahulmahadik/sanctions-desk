/**
 * Copy the small studies (not part of the recorded evaluation) into eval/studies/<study>/<run-id>/, in the same
 * shape and with the same redaction as `npm run evidence:export`: results.json, run-meta.json, trace.jsonl.gz and
 * receipts.jsonl.gz. Receipts are copied untouched (their signatures cover them); if one matches a redaction pattern
 * the export stops.
 *
 *   npm run studies:export
 *
 * It reads only files already in logs/ and calls nothing live. It fails when anything under eval/studies still
 * matches a redaction pattern, and reports the size. `npm run evidence:verify` checks every run it writes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
// @ts-expect-error plain JavaScript module shared with the repository scan
import { matches, REDACTIONS } from "../scripts/redaction-patterns.mjs";

const root = projectRoot();
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const logs = resolveProjectPath(config.logging.dir);
const outRoot = resolveProjectPath("eval/studies");

/** Each study: its folder name and the result files (under logs/) of its runs. */
const STUDIES: Array<{ name: string; runs: string[]; extra?: string[] }> = [
  {
    name: "nemotron-alone-v1-v3",
    runs: [
      "alone-v1v3/2026-10-24T17-11-05-604Z-heldout-once-nemotron_alone.json",
      "alone-v1v3/2026-10-24T17-54-48-801Z-heldout3-once-nemotron_alone.json",
    ],
  },
  {
    name: "repeat-heldout4",
    runs: [
      "repeat/2026-10-24T15-27-16-844Z-heldout4-repr1-routed.json",
      "repeat/2026-10-24T15-43-02-237Z-heldout4-r1-nemotron_alone.json",
      "repeat/2026-10-24T16-04-01-935Z-heldout4-repr2-routed.json",
      "repeat/2026-10-24T16-19-36-310Z-heldout4-r2-nemotron_alone.json",
      "repeat/2026-10-24T16-37-52-619Z-heldout4-repr3-routed.json",
      "repeat/2026-10-24T16-51-21-563Z-heldout4-r3-nemotron_alone.json",
      // The fairer arm: Nemotron alone given the free text the screener reads (text1 to text3).
      ...(existsSync(join(logs, "repeat"))
        ? readdirSync(join(logs, "repeat"))
            .filter((f) => /-heldout4-text\d-nemotron_alone\.json$/.test(f))
            .sort()
            .map((f) => `repeat/${f}`)
        : []),
    ],
  },
  {
    name: "heldout3-rerun",
    runs: [
      "v3today/2026-10-24T18-37-03-690Z-heldout3-todayt1-routed.json",
      "v3today/2026-10-24T19-02-37-626Z-heldout3-todayt2-routed.json",
      "v3today/2026-10-24T19-17-20-752Z-heldout3-todayt3-routed.json",
    ],
  },
  {
    name: "model-choice",
    runs: [
      "model-choice/2026-10-24T13-08-09-951Z-heldout4-choice-lightning.json",
      "model-choice/2026-10-24T14-29-12-021Z-choice-lightning.json",
    ],
    extra: ["model-choice/STUDY.md"],
  },
  {
    name: "privacy-mode",
    runs: [
      "privacy-test/2026-10-24T11-37-00-143Z-heldout4-privoff-routed.json",
      "privacy-test/2026-10-24T11-56-11-228Z-privoff-routed.json",
      "privacy-test/2026-10-24T12-18-20-249Z-heldout4-privon-routed.json",
      "privacy-test/2026-10-24T12-32-12-488Z-privon-routed.json",
    ],
  },
];

// Values of secret environment variables must never appear in what is published (as in evidence-export).
const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD)/i;
const secretValues = Object.entries(process.env)
  .filter(([k, v]) => SECRET_NAME.test(k) && (v ?? "").length >= 8)
  .map(([, v]) => v as string);

const counts = new Map<string, number>();
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

interface Result {
  variant: string;
  exam?: string | null;
  system?: string | null;
  started_at: string;
  finished_at: string;
  features?: unknown;
  policy_version: number;
  models: unknown;
  cases: Array<{ case_id: string }>;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const problems: string[] = [];
const index: Array<Record<string, unknown>> = [];

// Each study folder is written afresh; eval/studies/README.md (written by hand) is kept.
for (const study of STUDIES) rmSync(join(outRoot, study.name), { recursive: true, force: true });
for (const study of STUDIES) {
  for (const source of study.runs) {
    const path = join(logs, source);
    if (!existsSync(path)) {
      problems.push(`${study.name}: ${source} is missing`);
      continue;
    }
    const r = JSON.parse(readFileSync(path, "utf8")) as Result;
    // "<started>-<exam>-<system>-<variant>.json": the part after the time is the run's trace prefix.
    const stem = basename(source, ".json").replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "");
    const id = `${stem}-${r.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
    const dir = join(outRoot, study.name, id);
    mkdirSync(dir, { recursive: true });

    // The trace: the events of the run's last attempt at each case, within the run's time window.
    const until = new Date(Date.parse(r.finished_at) + 60_000).toISOString();
    const lines: string[] = [];
    const receiptIds = new Set<string>();
    for (const c of r.cases) {
      const name = join(logs, `trace-eval-${stem}-${c.case_id}.jsonl`);
      if (!existsSync(name)) {
        problems.push(`${id}: no trace for ${c.case_id}`);
        continue;
      }
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
      const rp = join(logs, "receipts", `${rid}.json`);
      if (!existsSync(rp)) {
        problems.push(`${id}: receipt ${rid} is named in the trace but its file is missing`);
        continue;
      }
      const text = JSON.stringify(JSON.parse(readFileSync(rp, "utf8")));
      const hit = matches(text);
      if (hit.length > 0) problems.push(`${id}: receipt ${rid} matches ${hit.join(", ")}; receipts cannot be edited`);
      receiptLines.push(text);
    }

    const files: Record<string, Buffer | string> = {
      "results.json": redact(readFileSync(path, "utf8")),
      "trace.jsonl.gz": gzipSync(`${lines.join("\n")}\n`, { level: 9 }),
      "receipts.jsonl.gz": gzipSync(`${receiptLines.join("\n")}\n`, { level: 9 }),
    };
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    const rel = relative(root, dir);
    const meta = {
      run_id: id,
      study: study.name,
      source: `logs/${source}`,
      variant: r.variant,
      exam: r.exam ?? "exam",
      system: r.system ?? null,
      started_at: r.started_at,
      finished_at: r.finished_at,
      policy_version: r.policy_version,
      features: r.features ?? null,
      nightshift_build: nightshiftBuildAt(r.started_at),
      models: r.models,
      cases: r.cases.length,
      events: lines.length,
      receipts: receiptLines.length,
      files: Object.fromEntries(
        Object.entries(files).map(([n, d]) => [n, { bytes: Buffer.byteLength(d), sha256: sha(d) }]),
      ),
      redacted:
        "tokens, local paths, hostnames and addresses other than the local machine, usernames, e-mail addresses and secret environment values were removed from results.json and trace.jsonl.gz; receipts.jsonl.gz is untouched",
      verify: `npm run evidence:verify -- ${rel}`,
    };
    writeFileSync(join(dir, "run-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    const bytes = readdirSync(dir).reduce((t, n) => t + statSync(join(dir, n)).size, 0);
    index.push({
      study: study.name,
      run_id: id,
      path: rel,
      source: meta.source,
      started_at: r.started_at,
      cases: r.cases.length,
      events: lines.length,
      receipts: receiptLines.length,
      bytes,
    });
  }
  for (const extra of study.extra ?? []) {
    const path = join(logs, extra);
    if (!existsSync(path)) {
      problems.push(`${study.name}: ${extra} is missing`);
      continue;
    }
    mkdirSync(join(outRoot, study.name), { recursive: true });
    writeFileSync(join(outRoot, study.name, basename(extra)), redact(readFileSync(path, "utf8")));
  }
}
// The three live reviews run with every step under its own Zetaris identity, and the read-only match of their
// statements with each identity's statement history. The sealed records are copied untouched, so their
// record hash still checks; like a receipt, a record that matches a redaction pattern stops the export.
const LIVE = "step-roles-live";
const liveOut = join(outRoot, "step-role-reviews");
rmSync(liveOut, { recursive: true, force: true });
if (existsSync(join(logs, LIVE))) {
  for (const alert of readdirSync(join(logs, LIVE), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const src = join(logs, LIVE, alert.name);
    const dir = join(liveOut, alert.name);
    mkdirSync(dir, { recursive: true });
    const one = (sub: string, re: RegExp) => readdirSync(join(src, sub)).filter((n) => re.test(n));
    const [record] = one("records", /^rec-.*\.json$/);
    const [trace] = one(".", /^trace-.*\.jsonl$/);
    if (!record || !trace) {
      problems.push(`${LIVE}/${alert.name}: record or trace missing`);
      continue;
    }
    const recordText = readFileSync(join(src, "records", record), "utf8");
    const hit = matches(recordText);
    if (hit.length > 0)
      problems.push(`${LIVE}/${alert.name}: the record matches ${hit.join(", ")}; records cannot be edited`);
    const receipts = one("receipts", /\.json$/)
      .sort()
      .map((n) => JSON.stringify(JSON.parse(readFileSync(join(src, "receipts", n), "utf8"))));
    for (const r of receipts)
      if (matches(r).length > 0) problems.push(`${LIVE}/${alert.name}: a receipt matches a pattern`);
    const traceLines = readFileSync(join(src, trace), "utf8").split("\n").filter(Boolean).map(redact);
    writeFileSync(join(dir, "record.json"), recordText);
    writeFileSync(join(dir, "trace.jsonl.gz"), gzipSync(`${traceLines.join("\n")}\n`, { level: 9 }));
    writeFileSync(join(dir, "receipts.jsonl.gz"), gzipSync(`${receipts.join("\n")}\n`, { level: 9 }));
  }
  const audit = join(logs, LIVE, "statement-history-audit.json");
  if (existsSync(audit))
    writeFileSync(join(liveOut, "statement-history-audit.json"), redact(readFileSync(audit, "utf8")));
  else problems.push(`${LIVE}: statement-history-audit.json missing`);
}

writeFileSync(join(outRoot, "index.json"), `${JSON.stringify({ runs: index }, null, 2)}\n`);

// Whatever is under eval/studies must be clean (receipts are held to it too: they were never edited).
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
let total = 0;
for (const file of walk(outRoot)) {
  const raw = readFileSync(file);
  total += raw.length;
  const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const hit = matches(text);
  if (hit.length > 0) problems.push(`${relative(root, file)} still matches: ${hit.join(", ")}`);
  for (const value of secretValues)
    if (text.includes(value)) problems.push(`${relative(root, file)} still holds a secret value`);
}

if (problems.length > 0) {
  console.error(`studies export FAILED:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
for (const s of index)
  console.log(
    `${String(s.path).padEnd(80)} ${String(s.events).padStart(6)} events ${String(s.receipts).padStart(5)} receipts ${(Number(s.bytes) / 1024).toFixed(0).padStart(5)} KiB`,
  );
console.log(
  `total ${(total / 1024 / 1024).toFixed(2)} MiB in ${index.length} run(s); redactions made: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
);

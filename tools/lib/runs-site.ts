/**
 * The "Recorded runs" pages of the static site (site/runs/): a read-only replay of a few cases from the committed run
 * exports, so a reader can follow one alert step by step without running anything. Everything shown comes from the
 * committed files: the trace and the signed receipts in eval/runs/<run-id>/, the result row, the case label in
 * eval/cases/, and, where an output example was exported from the same run, the sealed decision record that keeps
 * the Zetaris statements.
 *
 * The build stops (throws) when a run file is missing, when a model call names a receipt the export does not hold,
 * when a receipt's signature does not verify, or when the trace and the receipt disagree. Free text from the
 * synthetic data (customer notes, payment references) and list remarks never reach a page, and identifier numbers
 * are masked: `scrub` runs over every string before it is written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { resolveProjectPath, verifyReceipt } from "@sanctions-desk/shared";
import { problemsIn, type RunVerification, verifyExportedRun } from "./evidence.js";

export const REPO_URL = "https://github.com/rahulmahadik/sanctions-desk";
const REPO_BLOB = `${REPO_URL}/blob/main/`;
const QUICK_START = `${REPO_BLOB}README.md#quick-start`;
export const BANNER = "Replay of recorded runs. Nothing runs live here.";

/** One case shown on the site: which run it comes from and why it is worth reading. */
export interface RecordedCase {
  /** Page name in site/runs/ (without .html). */
  slug: string;
  /** Folder under eval/runs/. */
  runId: string;
  caseId: string;
  /** The case file that holds the label, relative to the repository root. */
  caseFile: string;
  /** One sentence: what this case shows. */
  shows: string;
  /** An output_examples/ folder exported from this same run and case, whose sealed record keeps the statements. */
  example?: string;
}

export const RECORDED_CASES: readonly RecordedCase[] = [
  {
    slug: "alr-0073",
    runId: "routed-20261023T133311Z",
    caseId: "EX-064",
    caseFile: "eval/cases/exam.json",
    shows:
      "A payment whose reference names a watched place: the decision step proposed a close, the critic approved it, and the raise-only policy guard stopped it.",
    example: "close-stopped-by-policy-guard",
  },
  {
    slug: "alr-0043",
    runId: "routed-20261023T133311Z",
    caseId: "EX-043",
    caseFile: "eval/cases/exam.json",
    shows:
      "An ownership chain: the decision step proposed a close three times, the critic sent it back each time, and the guard escalated it because the critic's objection was still open.",
  },
  {
    slug: "alr-0058",
    runId: "sys2b-routed-20261023T195504Z",
    caseId: "EX-051",
    caseFile: "eval/cases/exam.json",
    shows:
      "An earlier clearance that no longer holds: the listed entry changed after the earlier decision, so the memory step marked it stale and the case was reviewed again.",
  },
  {
    slug: "alr-0004",
    runId: "sys2b-routed-20261023T195504Z",
    caseId: "EX-004",
    caseFile: "eval/cases/exam.json",
    shows:
      "A close: a spelling variant of a listed name with a different date of birth and nationality; the critic approved it, the challenger found no credible argument against it, and the guard let it stand for a person to confirm.",
  },
  {
    slug: "alr-l0001",
    runId: "heldout4-sys4-routed-20261024T024523Z",
    caseId: "HO4-001",
    caseFile: "eval/cases/heldout4.json",
    shows:
      "A held-out case (labels written before the run): the structured fields alone would close it, but the local screener found a relationship to the listed person in the customer note, and the case was escalated.",
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Reading the committed files

interface ReceiptSummary {
  receipt_id?: string;
  pubkey_b64?: string;
  sig_b64?: string;
  body_hash?: string;
  verification?: string;
}

export interface TraceEvent {
  case_id: string;
  ts: string;
  run_id: string;
  seq: number;
  agent: string;
  action: string;
  status: string;
  input_summary?: string | null;
  output_summary?: string | null;
  target_agent?: string | null;
  confidence?: number | null;
  retry_count?: number | null;
  model_requested?: string;
  model_used?: string;
  route_kind?: string;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  zetaris_query_id?: string;
  policy_version?: number;
  receipt?: ReceiptSummary;
  detail?: Record<string, unknown>;
}

interface Route {
  kind?: string;
  label?: string;
  model?: string;
}
interface Envelope {
  pubkey_b64?: string;
  sig_b64?: string;
  body: { signer?: string; ts_ms?: number; receipt?: { receipt_id?: string; app?: string; winning_route?: Route } };
}

interface CaseLabel {
  case_id: string;
  title: string;
  alert_id: string;
  alert_type: string;
  customer_id: string;
  entry_id: string;
  expected: string;
  acceptable: string[];
  must_not: string[];
  note?: string;
}

interface ResultRow {
  case_id: string;
  expected: string;
  acceptable: string[];
  got: string;
  latency_s?: number;
  local_calls?: number;
  cloud_calls?: number;
  first_finding?: string;
  critic_rounds?: number;
  critic_final?: string;
}

interface RecordQuery {
  query_id: string;
  agent: string;
  table: string;
  sql: string;
  row_count: number;
  masked_columns?: string[];
}
interface SealedRecord {
  run_id: string;
  record_hash: string;
  queries: RecordQuery[];
  guards: Array<{ guard: string; verdict: string; detail?: string }>;
}

/** Thrown when a committed input is missing or does not verify; the site build exits non-zero on it. */
export class RecordedRunError extends Error {}

const need = (path: string, what: string): string => {
  if (!existsSync(path)) throw new RecordedRunError(`${what} is missing: ${path}`);
  return path;
};
const readJson = <T>(path: string, what: string): T => JSON.parse(readFileSync(need(path, what), "utf8")) as T;
const gzLines = (path: string, what: string): string[] =>
  gunzipSync(readFileSync(need(path, what)))
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A model call and its receipt, checked. */
export interface CheckedCall {
  seq: number;
  agent: string;
  requested?: string;
  traceModel?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  status: string;
  /** Absent when the trace names no receipt for the call (for example a call that failed). */
  receipt?: {
    id: string;
    app?: string;
    route: Route;
    /** The result of checking the signature now, with the same code as `npm run evidence:verify`. */
    checked: "valid_pinned" | "valid_unpinned";
    /** What the desk recorded when it checked the receipt during the run. */
    atRunTime?: string;
    keyFingerprint: string;
  };
}

export interface LoadedCase {
  spec: RecordedCase;
  label: CaseLabel;
  result: ResultRow;
  events: TraceEvent[];
  calls: CheckedCall[];
  record?: SealedRecord;
  /** The whole run's check, from the code `npm run evidence:verify` uses. */
  run: RunVerification;
  meta: { run_id: string; started_at?: string; finished_at?: string; policy_version?: number; redacted?: string };
}

export interface LoadOptions {
  /** Repository root that inputs are read from (default: this repository). */
  root?: string;
  /** Folder holding the run exports (default: <root>/eval/runs). */
  runsDir?: string;
  /** Pinned receipt keys. Empty by default, so the check is the one anyone can repeat from the committed files. */
  trustedKeys?: readonly string[];
}

const fingerprint = (pubkey: string) => createHash("sha256").update(pubkey).digest("hex").slice(0, 16);

/** Check the receipt a model call names: present, signature valid, same signature, body and model as the trace. */
function checkReceipt(
  e: TraceEvent,
  id: string,
  envelopes: Map<string, Envelope>,
  trusted: readonly string[],
  where: string,
): CheckedCall["receipt"] {
  const fail = (why: string) => new RecordedRunError(`${where}: receipt ${id} (step ${e.seq}, ${e.agent}) ${why}`);
  const env = envelopes.get(id);
  if (!env) throw fail("is not in receipts.jsonl.gz");
  const v = verifyReceipt(env, trusted);
  if (v.status !== "valid_pinned" && v.status !== "valid_unpinned")
    throw fail(`does not verify (${v.status}: ${v.reason ?? "no reason"})`);
  if (e.receipt?.sig_b64 && e.receipt.sig_b64 !== env.sig_b64)
    throw fail("carries a different signature in the trace and in the receipt file");
  if (e.receipt?.body_hash && v.bodyHash && e.receipt.body_hash !== v.bodyHash)
    throw fail("has a signed body that does not match the hash the trace kept");
  const route = env.body.receipt?.winning_route ?? {};
  if (e.model_used && route.model && e.model_used !== route.model)
    throw fail(`names ${route.model}, but the trace says ${e.model_used}`);
  return {
    id,
    app: env.body.receipt?.app,
    route,
    checked: v.status,
    atRunTime: e.receipt?.verification,
    keyFingerprint: fingerprint(env.pubkey_b64 ?? ""),
  };
}

function checkCalls(events: TraceEvent[], envelopes: Map<string, Envelope>, trusted: readonly string[], where: string) {
  return events
    .filter((x) => x.action === "model_answer")
    .map((e): CheckedCall => {
      const id = e.receipt?.receipt_id;
      return {
        seq: e.seq,
        agent: e.agent,
        requested: e.model_requested,
        traceModel: e.model_used,
        latencyMs: e.latency_ms,
        tokensIn: e.tokens_in,
        tokensOut: e.tokens_out,
        status: e.status,
        receipt: id ? checkReceipt(e, id, envelopes, trusted, where) : undefined,
      };
    });
}

/** The run's files, checked against the hashes run-meta.json records for the trace and the receipts. */
function readRunFiles(runDir: string, where: string) {
  const meta = readJson<LoadedCase["meta"] & { files?: Record<string, { sha256: string }> }>(
    join(runDir, "run-meta.json"),
    "run-meta.json",
  );
  for (const f of ["trace.jsonl.gz", "receipts.jsonl.gz"]) {
    const path = need(join(runDir, f), f);
    const expected = meta.files?.[f]?.sha256;
    if (expected && sha256File(path) !== expected)
      throw new RecordedRunError(`${where}: ${f} does not match the sha256 that run-meta.json records for it`);
  }
  const envelopes = new Map<string, Envelope>();
  for (const l of gzLines(join(runDir, "receipts.jsonl.gz"), "receipts.jsonl.gz")) {
    const env = JSON.parse(l) as Envelope;
    const id = env.body?.receipt?.receipt_id;
    if (id) envelopes.set(id, env);
  }
  const trace = gzLines(join(runDir, "trace.jsonl.gz"), "trace.jsonl.gz").map((l) => JSON.parse(l) as TraceEvent);
  const results = readJson<{ cases: ResultRow[] }>(join(runDir, "results.json"), "results.json");
  return { meta, envelopes, trace, results };
}

function readSealedRecord(root: string, spec: RecordedCase, events: TraceEvent[], where: string) {
  if (!spec.example) return undefined;
  const record = readJson<SealedRecord>(join(root, "output_examples", spec.example, "decision-record.json"), "record");
  const sealed = events.find((e) => e.action === "seal_record")?.detail?.record_hash;
  if (record.run_id !== events[0]?.run_id || record.record_hash !== sealed)
    throw new RecordedRunError(`${where}: output_examples/${spec.example} is not the record this run sealed`);
  return record;
}

/** Load one case from the committed files, checking every file, receipt and record it refers to. */
export function loadRecordedCase(spec: RecordedCase, opts: LoadOptions = {}): LoadedCase {
  const root = resolve(opts.root ?? resolveProjectPath("."));
  const runDir = join(resolve(opts.runsDir ?? join(root, "eval", "runs")), spec.runId);
  const where = `${spec.runId} ${spec.caseId}`;
  const { meta, envelopes, trace, results } = readRunFiles(runDir, where);
  const result = results.cases.find((c) => c.case_id === spec.caseId);
  if (!result) throw new RecordedRunError(`${where}: no result row for the case in results.json`);
  const labels = readJson<{ cases: CaseLabel[] }>(join(root, spec.caseFile), "case file");
  const label = labels.cases.find((c) => c.case_id === spec.caseId);
  if (!label) throw new RecordedRunError(`${where}: the case is not in ${spec.caseFile}`);

  const events = trace.filter((e) => e.case_id === spec.caseId).sort((a, b) => a.seq - b.seq);
  if (events.length === 0) throw new RecordedRunError(`${where}: no trace events for the case`);

  const calls = checkCalls(events, envelopes, opts.trustedKeys ?? [], where);
  if (!calls.some((c) => c.receipt)) throw new RecordedRunError(`${where}: no model call in the case has a receipt`);
  // The whole run, through the code `npm run evidence:verify` uses.
  const run = verifyExportedRun(runDir, [...(opts.trustedKeys ?? [])]);
  if (problemsIn(run) > 0)
    throw new RecordedRunError(
      `${where}: the run fails npm run evidence:verify (${run.status.invalid} invalid, ${run.status.malformed} malformed, ${run.missing.length} missing, ${run.mismatched.length} model mismatches)`,
    );

  const record = readSealedRecord(root, spec, events, where);
  return { spec, label, result, events, calls, record, meta, run };
}

// ---------------------------------------------------------------------------------------------------------------
// Scrubbing

/** Values that must never appear on a page: free text and identifier numbers for one case. */
export interface Protected {
  freeText: string[];
  idNumbers: string[];
  /**
   * Names that are fields of their own (the listed party's names, the customer's name). A quoted name is kept even
   * when the free text also mentions it; a run of free-text words around it is still withheld.
   */
  names?: string[];
}

type Row = Record<string, unknown>;
const rowsOf = (root: string, file: string): Row[] => {
  const j = readJson<Row[] | { rows: Row[] }>(join(root, file), file);
  return Array.isArray(j) ? j : j.rows;
};
const strings = (rows: Row[], field: string) =>
  rows.map((r) => r[field]).filter((v): v is string => typeof v === "string" && v.trim().length > 0);

/**
 * The free text and identifier numbers for a case's customer, payments and listed entry, read from the committed
 * synthetic data (data/synthetic/) and the list sample (data/sample/).
 */
export function protectedValuesFor(label: CaseLabel, root = resolveProjectPath(".")): Protected {
  const customers = rowsOf(root, "data/synthetic/customer.json").filter((r) => r.customer_id === label.customer_id);
  const alert = rowsOf(root, "data/synthetic/alert.json").find((r) => r.alert_id === label.alert_id);
  const payments = rowsOf(root, "data/synthetic/payment.json").filter(
    (r) => r.customer_id === label.customer_id || (alert?.payment_id && r.payment_id === alert.payment_id),
  );
  const entries = rowsOf(root, "data/sample/list_entry.json").filter((r) => r.entry_id === label.entry_id);
  const custIds = rowsOf(root, "data/synthetic/customer_identifier.json").filter(
    (r) => r.customer_id === label.customer_id,
  );
  const listIds = rowsOf(root, "data/sample/list_identifier.json").filter((r) => r.entry_id === label.entry_id);
  return {
    freeText: [
      ...strings(customers, "notes"),
      ...strings(payments, "payment_reference"),
      ...strings(entries, "remarks"),
      ...strings(listIds, "note"),
    ],
    idNumbers: [...strings(custIds, "id_number"), ...strings(listIds, "id_number")].filter((v) => v.length >= 5),
    names: [
      ...strings(customers, "full_name"),
      ...strings(entries, "primary_name"),
      ...strings(
        rowsOf(root, "data/sample/list_alias.json").filter((r) => r.entry_id === label.entry_id),
        "alias_name",
      ),
    ],
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WITHHELD = "[free text withheld]";
const MASKED = "[id number masked]";
/** Runs of this many words from a free-text value count as quoting it. */
export const WINDOW_WORDS = 4;

/** Every run of WINDOW_WORDS consecutive words in a value (the whole value when it is shorter). */
export function wordWindows(value: string): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= WINDOW_WORDS) return [words.join(" ")];
  const out: string[] = [];
  for (let i = 0; i + WINDOW_WORDS <= words.length; i += 1) out.push(words.slice(i, i + WINDOW_WORDS).join(" "));
  return out;
}

/**
 * Remove protected values from a string: identifier numbers are masked; a free-text value is withheld when it
 * appears whole, when a quoted span is part of it, or when any WINDOW_WORDS consecutive words of it appear.
 */
export function scrub(text: string, p: Protected): string {
  let out = text;
  const names = new Set((p.names ?? []).map((n) => n.trim().toLowerCase()));
  for (const id of p.idNumbers) out = out.replace(new RegExp(escapeRe(id), "gi"), MASKED);
  for (const value of p.freeText) {
    out = out.replace(new RegExp(escapeRe(value.trim()), "gi"), WITHHELD);
    out = out.replace(/(["'“‘])([^"'”’]{3,200})(["'”’])/g, (whole, open, inner, close) => {
      const span = String(inner).trim().toLowerCase();
      return value.toLowerCase().includes(span) && !names.has(span) ? `${open}${WITHHELD}${close}` : whole;
    });
    for (const w of wordWindows(value)) {
      const re = new RegExp(w.split(" ").map(escapeRe).join("\\s+"), "gi");
      out = out.replace(re, WITHHELD);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const OUTCOME_WORDS: Record<string, string> = {
  CLOSE_FALSE_POSITIVE: "Close as a false positive",
  ESCALATE_L2: "Escalate to level 2",
  NEED_MORE_INFO: "Ask for more information",
  RECOMMEND_BLOCK: "Recommend a block (two people must confirm)",
};
const outcome = (code: string | undefined) => (code ? `${OUTCOME_WORDS[code] ?? code} (${code})` : "none");

/** How the run's outcome compares with the label in the case file today. */
export function verdictOf(label: CaseLabel, got: string): "matches the label" | "acceptable" | "differs" {
  if (got === label.expected) return "matches the label";
  if (label.acceptable.includes(got)) return "acceptable";
  return "differs";
}

const modelText = (call: CheckedCall) => {
  const r = call.receipt?.route;
  const id = r?.model ?? call.traceModel;
  if (!id) return "none (no model answered)";
  const kind = r?.kind ?? (id.includes("lightning") ? "local" : "cloud");
  const suffix = call.receipt ? "" : "; named by the trace only";
  return `${r?.label ?? id} (${kind === "local" ? "local, Lightning" : "cloud, Ultra"}${suffix})`;
};
const checkedText = (call: CheckedCall) => {
  if (!call.receipt) return "no receipt recorded for this call";
  return call.receipt.checked === "valid_pinned"
    ? "signature valid, key pinned"
    : "signature valid, key from the receipt";
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${esc(title)}</title>
    <link rel="stylesheet" href="runs.css" />
  </head>
  <body>
    <main>
      <p class="banner" role="note"><strong>${esc(BANNER)}</strong> Every value below is read from files committed in the
      <a href="${REPO_URL}">repository</a>. To run the desk yourself, follow the
      <a href="${QUICK_START}">README quick start</a>.</p>
${body}
      <footer>
        <a href="../index.html">Site home</a> · <a href="index.html">All recorded runs</a> ·
        <a href="${REPO_URL}">Source on GitHub</a> (Apache-2.0)
      </footer>
    </main>
  </body>
</html>
`;

const table = (
  caption: string,
  head: string[],
  rows: string[][],
) => `      <div class="wrap" role="region" aria-label="${esc(caption)}" tabindex="0">
        <table>
          <caption>${esc(caption)}</caption>
          <thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>
${rows.map((r) => `            <tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")}
          </tbody>
        </table>
      </div>`;

const shortTable = (t: string | undefined) => (t ? (t.split(".").pop() ?? t) : "");
const rowsFromSummary = (s: string | null | undefined) => s?.match(/^(\d+) (?:\w+ )?rows?$/)?.[1];

/** The checks that stopped a proposed close, or that let a close stand, in the order they ran. */
function guardItem(c: LoadedCase, e: TraceEvent, s: Scrubbed): string {
  const verdicts = Array.isArray(e.detail?.verdicts) ? (e.detail.verdicts as string[]) : [];
  const raised = verdicts.filter((v) => /:(block|flag)$/.test(v));
  // The sealed record, where there is one, keeps each guard's reason; the trace keeps only the verdict names.
  const details = (c.record?.guards ?? [])
    .filter((g) => g.verdict === "block" || g.verdict === "flag")
    .map((g) => `${s(g.guard)}: ${s(g.verdict)}${g.detail ? ` (${s(g.detail)})` : ""}`);
  const list = details.length > 0 ? details : raised.map((v) => s(v.replace(":", ": ")));
  const tail = list.length > 0 ? `. Checks that raised or flagged: ${list.join("; ")}` : "";
  return `<li><strong>policy guard</strong> (raise-only rules in code): ${s(e.output_summary)}${tail}</li>`;
}

/** The trace events that say what a check concluded, and how each is introduced on the page. */
const CHECKS: Array<{ match: (e: TraceEvent) => boolean; intro: (e: TraceEvent) => string }> = [
  {
    match: (e) => e.agent === "screener" && e.action === "screen_text" && e.status === "blocked",
    intro: () => "<strong>screener</strong> (local model, reads the free text on the laptop)",
  },
  {
    match: (e) => e.agent === "critic" && e.action === "judge",
    intro: (e) => `<strong>critic</strong> (step ${e.seq})`,
  },
  { match: (e) => e.action === "challenge_result", intro: () => "<strong>challenger</strong>" },
  {
    match: (e) => e.agent === "memory" && e.action === "recall" && e.status === "blocked",
    intro: () => "<strong>memory</strong>",
  },
];

/** The checks that stopped a proposed close, or that let a close stand, in the order they ran. */
function checksOf(c: LoadedCase, s: Scrubbed): string[] {
  return c.events.flatMap((e) => {
    if (e.agent === "policy_guard" && e.action === "apply_policy") return [guardItem(c, e, s)];
    const check = CHECKS.find((k) => k.match(e));
    return check ? [`<li>${check.intro(e)}: ${s(e.output_summary)}</li>`] : [];
  });
}

function stoppedSection(c: LoadedCase, s: Scrubbed): string {
  const proposals = c.events.filter(
    (e) => e.agent === "decision" && e.action === "recommend" && e.output_summary?.startsWith("CLOSE_FALSE_POSITIVE"),
  );
  const firstFinding = c.events.find((e) => e.action === "path")?.detail?.first_finding;
  const final = c.result.got;
  const items = checksOf(c, s).join("\n");
  if (final !== "CLOSE_FALSE_POSITIVE" && (proposals.length > 0 || firstFinding === "CLOSE_FALSE_POSITIVE")) {
    const lead =
      proposals.length > 0
        ? `The decision step proposed a close ${proposals.length === 1 ? "once" : `${proposals.length} times`}; the run ended at ${esc(outcome(final))}.`
        : `The code's first finding from the structured fields was a close; the run ended at ${esc(outcome(final))}.`;
    return `      <h2 id="stopped">Why the close was stopped</h2>
      <p>${lead} What each check said, in order:</p>
      <ul class="checks">
${items}
      </ul>`;
  }
  if (final === "CLOSE_FALSE_POSITIVE")
    return `      <h2 id="stopped">Why the close stood</h2>
      <p>No check stopped this close. It is still only a recommendation: a person confirms or changes it. What each check said:</p>
      <ul class="checks">
${items}
      </ul>`;
  return `      <h2 id="stopped">Checks along the way</h2>
      <p>No close was proposed in this run. What each check said:</p>
      <ul class="checks">
${items}
      </ul>`;
}

type Scrubbed = (x: unknown) => string;

/** One table row per trace event: what happened, the model and receipt for a model call, the Zetaris read. */
function stepRows(c: LoadedCase, s: Scrubbed): string[][] {
  const byQuery = new Map((c.record?.queries ?? []).map((q) => [q.query_id, q]));
  const callBySeq = new Map(c.calls.map((x) => [x.seq, x]));
  const receiptCell = (call: CheckedCall | undefined) => {
    if (!call) return "";
    if (!call.receipt) return esc(checkedText(call));
    return `<code>${esc(call.receipt.id)}</code><br />${esc(checkedText(call))}`;
  };
  const queryCell = (e: TraceEvent) => {
    const q = e.zetaris_query_id;
    if (!q) return "";
    const rec = byQuery.get(q);
    const rows = rec?.row_count ?? rowsFromSummary(e.output_summary);
    const table = rec?.table ?? (e.detail?.table as string | undefined) ?? e.action;
    return `${esc(shortTable(table))}${rows !== undefined ? `, ${esc(rows)} rows` : ""}<br /><code>${esc(q)}</code>`;
  };
  return c.events.map((e) => {
    const call = callBySeq.get(e.seq);
    const what = [e.input_summary ? `<span class="muted">in:</span> ${s(e.input_summary)}` : "", s(e.output_summary)]
      .filter(Boolean)
      .join("<br />");
    return [
      String(e.seq),
      esc(e.agent),
      esc(e.action),
      `<span class="st st-${esc(e.status)}">${esc(e.status)}</span>`,
      what,
      call ? esc(modelText(call)) : "",
      receiptCell(call),
      queryCell(e),
    ];
  });
}

/** One case's page. */
export function renderCasePage(c: LoadedCase, p: Protected): string {
  const s: Scrubbed = (x) => esc(scrub(String(x ?? ""), p));
  const { label, result, spec } = c;
  const v = verdictOf(label, result.got);
  const relabelled =
    result.expected !== label.expected
      ? `<p class="note">When this run was scored, the case file's label was ${esc(outcome(result.expected))}. The case was relabelled afterwards; the change and its reason are in <a href="${REPO_BLOB}eval/cases/README.md">eval/cases/README.md</a>. The comparison above uses today's label.</p>`
      : "";
  const first = c.events[0]?.ts;
  const last = c.events.at(-1)?.ts;
  const seconds = first && last ? ((Date.parse(last) - Date.parse(first)) / 1000).toFixed(1) : "?";
  const receipts = c.calls.filter((x) => x.receipt);
  const unpinned = receipts.some((x) => x.receipt?.checked === "valid_unpinned");
  const steps = stepRows(c, s);

  const callRows = c.calls.map((x) => [
    String(x.seq),
    esc(x.agent),
    esc(x.requested ?? ""),
    esc(modelText(x)),
    x.receipt ? `<code>${esc(x.receipt.id)}</code>` : "none",
    esc(x.receipt?.app ?? ""),
    esc(checkedText(x)),
    esc(x.receipt?.atRunTime ?? ""),
    x.latencyMs !== undefined ? `${(x.latencyMs / 1000).toFixed(1)} s` : "",
    x.tokensIn !== undefined ? `${x.tokensIn} / ${x.tokensOut ?? 0}` : "",
  ]);

  const queryRows = c.record
    ? c.record.queries.map((q) => [
        esc(q.agent),
        esc(shortTable(q.table)),
        esc(q.row_count),
        `<code class="sql">${s(q.sql)}</code>${q.masked_columns?.length ? `<br /><span class="muted">masked in the result: ${esc(q.masked_columns.join(", "))}</span>` : ""}`,
        `<code>${esc(q.query_id)}</code>`,
      ])
    : c.events
        .filter((e) => e.zetaris_query_id)
        .map((e) => [
          esc(e.agent),
          esc(shortTable((e.detail?.table as string | undefined) ?? e.action)),
          esc(rowsFromSummary(e.output_summary) ?? s(e.output_summary)),
          `<span class="muted">not kept in this run's export (step: ${esc(e.action)}${e.input_summary ? `, ${s(e.input_summary)}` : ""})</span>`,
          `<code>${esc(e.zetaris_query_id)}</code>`,
        ]);
  const querySource = c.record
    ? `The statements are exactly as the sealed decision record of this run keeps them (<a href="${REPO_BLOB}output_examples/${esc(spec.example)}/decision-record.json">output_examples/${esc(spec.example)}/decision-record.json</a>; its hash matches the one the trace logged when it was sealed). The record keeps each statement and a hash of each row returned, not the rows themselves.`
    : "This run's export keeps the table, the row count and the Zetaris query id of each read, not the statement text; the statements are not reconstructed here.";

  const runMeta = `${REPO_BLOB}eval/runs/${spec.runId}/run-meta.json`;
  const body = `      <p class="crumbs"><a href="index.html">Recorded runs</a> / ${esc(label.alert_id)}</p>
      <h1>${esc(label.alert_id)}: ${s(label.title)}</h1>
      <p>${s(spec.shows)}</p>

      <h2 id="outcome">Outcome</h2>
      <dl class="facts">
        <dt>Desk recommendation</dt><dd><strong>${esc(outcome(result.got))}</strong></dd>
        <dt>Label in the case file</dt><dd>${esc(outcome(label.expected))}${label.acceptable.length ? `; also acceptable: ${label.acceptable.map(esc).join(", ")}` : ""} (<a href="${REPO_BLOB}${esc(spec.caseFile)}">${esc(spec.caseFile)}</a>, case ${esc(label.case_id)})</dd>
        <dt>Compared with the label</dt><dd>${esc(v)}</dd>
        <dt>Code's first finding</dt><dd>${esc(outcome(result.first_finding))}</dd>
        <dt>Critic</dt><dd>${esc(result.critic_rounds ?? 0)} round(s), final: ${esc(result.critic_final ?? "not run")}</dd>
        <dt>Model calls</dt><dd>${c.calls.length} (${c.calls.filter((x) => modelText(x).includes("local")).length} local, ${c.calls.filter((x) => modelText(x).includes("cloud")).length} cloud); ${receipts.length} with a signed receipt, all verified</dd>
        <dt>Run</dt><dd><a href="${runMeta}">${esc(spec.runId)}</a>, policy version ${esc(c.events[0]?.policy_version ?? c.meta.policy_version ?? "?")}, ${c.events.length} steps in ${seconds} s</dd>
      </dl>
      ${label.note ? `<p class="muted">Case note from the case file: ${s(label.note)}</p>` : ""}
      ${relabelled}

${stoppedSection(c, s)}

      <h2 id="steps">Steps in order</h2>
      <p class="muted">Each line is one event from the run's trace (<code>trace.jsonl.gz</code>). The model is the one that served the call, as the signed receipt records it.</p>
${table("Every step of the run, in order", ["#", "Agent", "Action", "Status", "What happened", "Model", "Receipt", "Zetaris read"], steps)}

      <h2 id="receipts">Model calls and receipts</h2>
      <p>Each signature was checked when this page was built, with the same code as <code>npm run evidence:verify</code> (Ed25519 over the receipt body in <code>receipts.jsonl.gz</code>); the build stops if one does not verify, is missing, or names a different model from the trace.${unpinned ? " No key is pinned for the site build, so the check uses the key carried in each receipt: <strong>signature valid, key from the receipt</strong> shows the receipt was not changed after signing, not who signed it. The column “at run time” is what the desk recorded when it checked the receipt against its pinned key during the run." : ""}</p>
${table("Model calls and their receipts", ["#", "Step", "Mode asked for", "Model that served it", "Receipt", "App", "Checked now", "At run time", "Time", "Tokens in / out"], callRows)}
      <p>The whole run passes the same check: ${c.run.receipts} receipts with valid signatures, ${c.run.calls} model calls in the trace that name a receipt, none missing and none naming a different model from its receipt.</p>
      <p class="muted">Signing key fingerprint (first 16 hex of SHA-256): ${[...new Set(receipts.map((x) => x.receipt?.keyFingerprint))].map((k) => `<code>${esc(k)}</code>`).join(", ")}.</p>

      <h2 id="queries">Zetaris queries</h2>
      <p>${querySource}</p>
${table("Zetaris reads in this run", ["Agent", "Table", "Rows", "Statement", "Query id"], queryRows)}

      <h2 id="check">Check it yourself</h2>
      <p>Clone the repository and run <code>npm run evidence:verify -- eval/runs/${esc(spec.runId)}</code>. ${c.meta.redacted ? `What the export left out: ${s(c.meta.redacted)}.` : ""}</p>`;
  return page(`${label.alert_id}: recorded run`, body);
}

export function renderIndexPage(cases: Array<LoadedCase & { protect: Protected }>): string {
  const rows = cases.map((c) => [
    `<a href="${esc(c.spec.slug)}.html">${esc(c.label.alert_id)}</a>`,
    esc(scrub(c.label.title, c.protect)),
    esc(outcome(c.result.got)),
    esc(outcome(c.label.expected)),
    esc(verdictOf(c.label, c.result.got)),
    `${c.calls.filter((x) => x.receipt).length} of ${c.calls.length}`,
    `<code>${esc(c.spec.runId)}</code>`,
  ]);
  const body = `      <h1>Recorded runs</h1>
      <p>A few alerts from the committed run exports, shown step by step: which agent did what, which Nemotron model served each model call (local Lightning or cloud Ultra), the signed receipt for each call and whether it verifies, the Zetaris reads, and why a proposed close was stopped. The pages are built from the committed files by <code>npm run site:build</code>; the build stops if a receipt is missing or does not verify.</p>
      <p class="muted">Customers and payments are synthetic; listed parties are public sanctions-list entries. Customer notes, payment references and list remarks are not shown, and identifier numbers are masked.</p>
${table("The recorded cases", ["Alert", "Case", "Desk recommendation", "Label", "Compared", "Calls with a verified receipt", "Run"], rows)}
      <ul class="links">
${cases.map((c) => `        <li><a href="${esc(c.spec.slug)}.html">${esc(c.label.alert_id)}</a>: ${esc(scrub(c.spec.shows, c.protect))}</li>`).join("\n")}
      </ul>`;
  return page("Recorded runs", body);
}

export const RUNS_CSS = `* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #f6f7f9; color: #16181d; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6rem; margin: 8px 0 8px; overflow-wrap: anywhere; }
h2 { font-size: 1.2rem; margin: 32px 0 10px; }
p { margin: 0 0 12px; }
a { color: #1d4ed8; }
a:focus-visible, .wrap:focus-visible { outline: 3px solid #d97706; outline-offset: 2px; }
code { font: 0.85em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
code.sql { white-space: pre-wrap; display: block; min-width: 28ch; }
.banner { background: #fff7e6; border: 1px solid #f0c36d; border-radius: 8px; padding: 10px 14px; }
.muted, .crumbs { color: #4b5563; }
.note { background: #eef2ff; border-radius: 8px; padding: 8px 12px; }
.facts { display: grid; grid-template-columns: minmax(0, 14em) minmax(0, 1fr); gap: 4px 16px; background: #fff; border: 1px solid #d9dde3; border-radius: 8px; padding: 12px 14px; }
.facts dt { font-weight: 600; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) { .facts { grid-template-columns: minmax(0, 1fr); } .facts dd { margin-bottom: 8px; } }
.checks li, .links li { margin-bottom: 6px; overflow-wrap: anywhere; }
.wrap { max-width: 100%; overflow-x: auto; background: #fff; border: 1px solid #d9dde3; border-radius: 8px; margin: 0 0 12px; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
caption { text-align: left; font-weight: 600; padding: 8px 10px; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px; border-top: 1px solid #e5e7eb; }
th { background: #f3f4f6; white-space: nowrap; }
td { min-width: 10ch; }
td:first-child { min-width: 0; white-space: nowrap; }
.st { font-weight: 600; }
.st-blocked, .st-error { color: #b42318; }
.st-retry { color: #b54708; }
.st-ok { color: #067647; }
footer { margin-top: 40px; color: #4b5563; font-size: 0.9rem; }
`;

/**
 * Build the recorded-run pages into `outDir` (site/runs/ in the built site). Returns the files written, relative to
 * `outDir`. Throws RecordedRunError when an input is missing or a receipt does not verify.
 */
export function buildRunPages(outDir: string, opts: LoadOptions & { cases?: readonly RecordedCase[] } = {}): string[] {
  const root = resolve(opts.root ?? resolveProjectPath("."));
  const loaded = (opts.cases ?? RECORDED_CASES).map((spec) => {
    const c = loadRecordedCase(spec, opts);
    return { ...c, protect: protectedValuesFor(c.label, root) };
  });
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const c of loaded) {
    const html = renderCasePage(c, c.protect);
    writeFileSync(join(outDir, `${c.spec.slug}.html`), html);
    written.push(`${c.spec.slug}.html`);
  }
  writeFileSync(join(outDir, "index.html"), renderIndexPage(loaded));
  writeFileSync(join(outDir, "runs.css"), RUNS_CSS);
  written.push("index.html", "runs.css");
  return written;
}

/**
 * The "Recorded runs" pages of the static site (site/runs/): a read-only replay of a few cases, built only from the
 * committed run exports (trace, signed receipts, result row, case label, sealed record).
 *
 * The build throws when a run file is missing, a receipt is missing or does not verify, or the trace and the receipt
 * disagree. Free text and list remarks never reach a page and identifier numbers are masked: `scrub` runs over every
 * string before it is written. The one exception is a span the screener flagged: only the characters at that signal's
 * recorded position are shown (the data is synthetic), never the rest of the text.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig, resolveProjectPath, verifyReceipt } from "@sanctions-desk/shared";
import { problemsIn, type RunVerification, verifyExportedRun } from "./evidence.js";
import { esc, pageOf, REPO_URL, tableOf } from "./site-chrome.js";

export { esc, REPO_URL };

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
  /**
   * The one phrase of the case's synthetic free text this page may show, in the case description and case note in
   * place of the withheld text, labelled "(synthetic)". It must be a part of the named field, word for word.
   */
  quote?: { field: string; phrase: string };
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
    slug: "alr-0030",
    runId: "sys2b-routed-20261023T195504Z",
    caseId: "EX-030",
    caseFile: "eval/cases/exam.json",
    shows:
      "A data-quality rule blocks a close: the customer has no date of birth on record, so the Zetaris rule dob_present_for_individuals fails, the policy guard blocks any close, and the case goes to a person as need more information.",
    example: "need-more-info-critic-sent-back",
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
    quote: { field: "customer.notes", phrase: "the account is run for her uncle, Valeriy Igorevich Limarenko" },
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
  /** Who answered: nightshift, ollama (the local backup, no receipt) or fallback-rules (a baseline's stand-in). */
  provider?: string;
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
  alert_ref?: string;
  alert_type?: string;
  decision?: string;
  human?: unknown[];
  queries: RecordQuery[];
  guards: Array<{ guard: string; verdict: string; detail?: string }>;
}

/** Thrown when a committed input is missing or does not verify; the site build exits non-zero on it. */
export class RecordedRunError extends Error {}

/** The Nightshift receipt key the configuration pins (committed in config/default.json); receipts must carry it. */
export const pinnedKeys = (): readonly string[] =>
  loadConfig({ env: { SAMPLE_MODE: "true" } }).nightshift.receiptPublicKeys;

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

export interface CheckedCall {
  seq: number;
  agent: string;
  requested?: string;
  traceModel?: string;
  provider?: string;
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
  /** Pinned receipt keys. By default the key the configuration pins, so a receipt signed by another key fails. */
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

export function checkCalls(
  events: TraceEvent[],
  envelopes: Map<string, Envelope>,
  trusted: readonly string[],
  where: string,
) {
  return events
    .filter((x) => x.action === "model_answer")
    .map((e): CheckedCall => {
      const id = e.receipt?.receipt_id;
      return {
        seq: e.seq,
        agent: e.agent,
        requested: e.model_requested,
        traceModel: e.model_used,
        provider: e.provider,
        latencyMs: e.latency_ms,
        tokensIn: e.tokens_in,
        tokensOut: e.tokens_out,
        status: e.status,
        receipt: id ? checkReceipt(e, id, envelopes, trusted, where) : undefined,
      };
    });
}

/** The run's files, checked against the hashes run-meta.json records for the trace and the receipts. */
export function readRunFiles(runDir: string, where: string) {
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

  const calls = checkCalls(events, envelopes, opts.trustedKeys ?? pinnedKeys(), where);
  if (!calls.some((c) => c.receipt)) throw new RecordedRunError(`${where}: no model call in the case has a receipt`);
  const run = verifyExportedRun(runDir, [...(opts.trustedKeys ?? pinnedKeys())]);
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
  /** The raw free-text fields the screener reads, by the name its trace uses, for showing a flagged span only. */
  fields?: Record<string, string>;
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
    fields: Object.fromEntries(
      [
        ["customer.notes", customers.length === 1 ? strings(customers, "notes")[0] : undefined],
        ["payment.payment_reference", payments.length === 1 ? strings(payments, "payment_reference")[0] : undefined],
        ["list_entry.remarks", entries.length === 1 ? strings(entries, "remarks")[0] : undefined],
      ].filter((x): x is [string, string] => typeof x[1] === "string"),
    ),
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

/**
 * A case-file text (the case description or the case note) as HTML, scrubbed. When the case has an allowed quote, the
 * first withheld part and the rest of its clause are replaced by that quote, labelled synthetic; nothing else is shown.
 */
export function quotedText(text: string, spec: RecordedCase, p: Protected): string {
  const scrubbed = scrub(text, p);
  if (!spec.quote || !scrubbed.includes(WITHHELD)) return esc(scrubbed);
  const { field, phrase } = spec.quote;
  if (!p.fields?.[field]?.includes(phrase))
    throw new RecordedRunError(`${spec.slug}: the quote is not part of ${field} word for word`);
  const MARK = "\u0000quote\u0000";
  return esc(scrubbed.replace(new RegExp(`${escapeRe(WITHHELD)}[^,;.]*`), MARK)).replace(
    MARK,
    `<q class="case-quote">${esc(phrase)}</q> (synthetic)`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

const OUTCOME_WORDS: Record<string, string> = {
  CLOSE_FALSE_POSITIVE: "Close as a false positive",
  ESCALATE_L2: "Escalate to level 2",
  NEED_MORE_INFO: "Ask for more information",
  RECOMMEND_BLOCK: "Recommend a block (two people must confirm)",
};
const outcome = (code: string | undefined) => (code ? `${OUTCOME_WORDS[code] ?? code} (${code})` : "none");

/** One line that explains the outcome codes and the raise-only guard, from the same words the pages use. */
export const LEGEND = `${Object.entries(OUTCOME_WORDS)
  .map(([code, words]) => `${code} = ${words.toLowerCase()}`)
  .join(" · ")}. Raise-only: the policy guard can make an outcome more cautious, never less.`;

/** The record a person's approval of each outcome leads to (packages/agents/src/actions.ts, planActions). */
const NEXT_RECORD: Record<string, string> = {
  CLOSE_FALSE_POSITIVE: "a closure note",
  ESCALATE_L2: "an escalation ticket for a level-2 review",
  NEED_MORE_INFO: "a request-for-information draft, which a person must approve before it is used",
  RECOMMEND_BLOCK: "an escalation ticket that waits for a second, different approver",
};

/** "What the reviewer does next", from the sealed record: its outcome, its alert type and the human step so far. */
export function nextStepLine(record: SealedRecord | undefined): string {
  if (!record?.decision || !record.alert_ref) return "";
  const decided = (record.human ?? []).length > 0;
  const hold =
    record.alert_type === "payment" && (record.decision === "ESCALATE_L2" || record.decision === "RECOMMEND_BLOCK")
      ? ", and, for this payment alert, a draft hold instruction for the pending payment"
      : "";
  return `${decided ? "A person has acted on this record." : "The sealed record holds no human decision yet, so nothing has been prepared."} The reviewer approves ${outcome(record.decision)} or overrides it with a reason. On approval the desk prepares ${NEXT_RECORD[record.decision] ?? "the matching next-action record"} for ${record.alert_ref}${hold}. Nothing is sent.`;
}

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
  if (call.provider === "ollama") return `${id} (local, Lightning, the Ollama backup on this machine)`;
  const kind = r?.kind ?? (id.includes("lightning") ? "local" : "cloud");
  const suffix = call.receipt ? "" : "; named by the trace only";
  return `${r?.label ?? id} (${kind === "local" ? "local, Lightning" : "cloud, Ultra"}${suffix})`;
};
const checkedText = (call: CheckedCall) => {
  if (!call.receipt && call.provider === "ollama")
    return "no receipt: the Ollama backup answered, not through Nightshift";
  if (!call.receipt) return "no receipt recorded for this call";
  return call.receipt.checked === "valid_pinned"
    ? "signature valid, key pinned"
    : "signature valid, key from the receipt";
};

/** Which model answered: for the colour of the model's name on the page (the same colours as the diagrams). */
export function modelKindOf(call: Pick<CheckedCall, "provider" | "traceModel" | "receipt">) {
  if (call.provider === "ollama" && call.traceModel) return "ollama";
  const m = call.receipt?.route.model ?? (call.receipt ? call.traceModel : undefined) ?? call.traceModel ?? "";
  if (/ultra/i.test(m)) return "ultra";
  if (/lightning/i.test(m)) return "lightning";
  return "none";
}
/** The model's description as text, coloured by the model that answered. */
const modelCell = (call: CheckedCall) => `<span class="model-${modelKindOf(call)}">${esc(modelText(call))}</span>`;

const page = (title: string, description: string, body: string) =>
  pageOf(
    { title, description, depth: 1, current: "runs/index.html", bodyClass: "page-runs" },
    `      <p class="banner" role="note"><strong>${esc(BANNER)}</strong> Every value below is read from files committed in the
      <a href="${REPO_URL}">repository</a>. To run the desk yourself, follow the
      <a href="${QUICK_START}">README quick start</a>.</p>
${body}`,
  );

const table = tableOf;

const shortTable = (t: string | undefined) => (t ? (t.split(".").pop() ?? t) : "");
const rowsFromSummary = (s: string | null | undefined) => s?.match(/^(\d+) (?:\w+ )?rows?$/)?.[1];

/** The policy guard's list item, with the checks that raised or flagged. */
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
      `<code>${esc(e.action)}</code>`,
      `<span class="st st-${esc(e.status)}">${esc(e.status)}</span>`,
      what,
      call ? modelCell(call) : "",
      receiptCell(call),
      queryCell(e),
    ];
  });
}

/** A risk signal as the screener's trace line records it: type, confidence, field, character span, grounding. */
export interface FlaggedSignal {
  type: string;
  confidence: number;
  field: string;
  start: number;
  end: number;
  grounded: boolean;
}
/** The longest span shown on a page; a longer one is not shown at all. */
export const MAX_SPAN_CHARS = 120;

/** The located signals of the screener's verdicts in a case's trace (signals without a location are left out). */
export function flaggedSignals(events: readonly TraceEvent[]): FlaggedSignal[] {
  const out: FlaggedSignal[] = [];
  for (const e of events.filter((x) => x.agent === "screener" && x.action === "screen_text")) {
    for (const m of (e.output_summary ?? "").matchAll(/(\w+) ([\d.]+) at ([\w.]+):(\d+)-(\d+)( \(not grounded\))?/g))
      out.push({
        type: m[1] as string,
        confidence: Number(m[2]),
        field: m[3] as string,
        start: Number(m[4]),
        end: Number(m[5]),
        grounded: m[6] === undefined,
      });
  }
  return out;
}

/** The exact characters of a signal's span in the raw field, or undefined when the field or span cannot be shown. */
export function spanText(sig: FlaggedSignal, p: Protected): string | undefined {
  const raw = p.fields?.[sig.field];
  if (raw === undefined || sig.end <= sig.start || sig.end > raw.length || sig.end - sig.start > MAX_SPAN_CHARS)
    return undefined;
  return raw.slice(sig.start, sig.end);
}

const sentenceCase = (t: string) => `${t[0]?.toUpperCase() ?? ""}${t.slice(1)}`;
const codeOf = (summary: string | null | undefined) => summary?.match(/^([A-Z0-9_]+)\b/)?.[1];

/** One line, from the trace and the result row: what the checks did and what the run ended at. No free text. */
export function whatHappened(c: LoadedCase): string {
  const parts: string[] = [];
  const signals = c.events
    .filter((e) => e.agent === "screener" && e.action === "screen_text" && e.status === "blocked")
    .flatMap((e) => [...(e.output_summary ?? "").matchAll(/(\w+) ([\d.]+) at ([\w.]+):/g)])
    .map((m) => ({ type: m[1] as string, conf: m[2] as string, field: m[3] as string }));
  if (signals.length > 0)
    parts.push(
      `the local screener flagged ${signals.length} risk ${signals.length === 1 ? "signal" : "signals"} in ${[...new Set(signals.map((x) => x.field))].join(" and ")} (${signals.map((x) => `${x.type.replaceAll("_", " ")} ${x.conf}`).join(", ")}), which blocks a close`,
    );
  const recs = c.events.filter((e) => e.agent === "decision" && e.action === "recommend");
  const closes = recs.filter((e) => codeOf(e.output_summary) === "CLOSE_FALSE_POSITIVE").length;
  const last = codeOf(recs.at(-1)?.output_summary);
  if (closes > 0) parts.push(`the decision step proposed a close ${closes === 1 ? "once" : `${closes} times`}`);
  else if (last) parts.push(`the decision step recommended ${last}`);
  const judged = c.events.filter((e) => e.agent === "critic" && e.action === "judge");
  const sentBack = judged.filter((e) => e.status === "blocked").length;
  if (judged.length > 0)
    parts.push(
      sentBack === 0
        ? `the critic approved it`
        : `the critic sent it back ${sentBack === 1 ? "once" : `${sentBack} times`}${sentBack < judged.length ? " and then approved it" : ""}`,
    );
  const guard = c.events.filter((e) => e.agent === "policy_guard" && e.action === "apply_policy").at(-1);
  if (guard) {
    const verdicts = Array.isArray(guard.detail?.verdicts) ? (guard.detail.verdicts as string[]) : [];
    const raised = verdicts.filter((v) => /:block$/.test(v)).map((v) => v.split(":")[0]);
    const raisedTo = guard.output_summary?.match(/raised to ([A-Z0-9_]+)/)?.[1];
    parts.push(
      raisedTo
        ? `the policy guard raised it to ${raisedTo}${raised.length > 0 ? ` (rule: ${raised.join(", ")})` : ""}`
        : "the policy guard let it stand",
    );
  }
  const v = verdictOf(c.label, c.result.got);
  const against =
    v === "matches the label"
      ? "as the label expects"
      : v === "acceptable"
        ? "an outcome the label accepts"
        : "not what the label expects";
  return `${sentenceCase(parts.join("; "))}. Outcome: ${outcome(c.result.got)}, ${against}.`;
}

/**
 * The label directly above the recorded spans when every shown signal is marked not grounded: the screener's offsets
 * missed the words, the desk marked the signals accordingly, and they still block a close.
 */
export const UNGROUNDED_SPANS_LABEL =
  "Spans as recorded by the local screener. Their offsets are off, so the desk marked these signals not grounded; ungrounded signals still block a close by design.";

/** The flagged spans of a case, as a short section; empty when the screener located none that can be shown. */
function flaggedSection(c: LoadedCase, p: Protected): string {
  const shown = flaggedSignals(c.events).flatMap((sig) => {
    const text = spanText(sig, p);
    return text === undefined ? [] : [{ sig, text }];
  });
  const rows = shown.map(
    ({ sig, text }) =>
      `        <li>${esc(sig.type.replaceAll("_", " "))}, confidence ${esc(sig.confidence)}, ${esc(sig.field)} characters ${sig.start}–${sig.end}${sig.grounded ? "" : ", marked not grounded"}: <q class="flagged-span">${esc(text)}</q></li>`,
  );
  if (rows.length === 0) return "";
  const label = shown.every(({ sig }) => !sig.grounded)
    ? `\n      <p class="spans-label"><strong>${esc(UNGROUNDED_SPANS_LABEL)}</strong></p>`
    : "";
  return `      <div class="note">
      <p><strong>The free text the screener flagged</strong> (synthetic data). Only the characters at each signal's recorded position are shown; the rest of the text stays withheld. A signal marked not grounded is still shown to the reviewer and still blocks a close (policy version 8).</p>${label}
      <ul class="checks">
${rows.join("\n")}
      </ul>
      </div>`;
}

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
    x.requested ? `<code>${esc(x.requested)}</code>` : "",
    modelCell(x),
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
  const body = `      <div class="page-head">
      <p class="crumbs"><a href="index.html">Recorded runs</a> / ${esc(label.alert_id)}</p>
      <h1>${esc(label.alert_id)}: ${quotedText(label.title, spec, p)}</h1>
      </div>
      <p class="what"><strong>What happened:</strong> ${s(whatHappened(c))}</p>
      <p class="muted legend"><strong>Outcomes:</strong> ${esc(LEGEND)}</p>
${flaggedSection(c, p)}
      <p class="measure">${s(spec.shows)}</p>

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
      ${label.note ? `<p class="muted">Case note from the case file: ${quotedText(label.note, spec, p)}</p>` : ""}
      ${relabelled}
      ${nextStepLine(c.record) ? `<p class="next"><strong>What the reviewer does next:</strong> ${s(nextStepLine(c.record))}</p>` : ""}

${stoppedSection(c, s)}

      <h2 id="steps">Steps in order</h2>
      <p class="muted">Each line is one event from the run's trace (<code>trace.jsonl.gz</code>). The model is the one that served the call, as the signed receipt records it.</p>
${table("Every step of the run, in order", ["#", "Agent", "Action", "Status", "What happened", "Model", "Receipt", "Zetaris read"], steps, { num: [0] })}

      <h2 id="receipts">Model calls and receipts</h2>
      <p>Each signature was checked when this page was built, with the same code as <code>npm run evidence:verify</code> (Ed25519 over the receipt body in <code>receipts.jsonl.gz</code>); the build stops if one does not verify, is missing, or names a different model from the trace.${unpinned ? " No key is pinned for the site build, so the check uses the key carried in each receipt: <strong>signature valid, key from the receipt</strong> shows the receipt was not changed after signing, not who signed it. The column “at run time” is what the desk recorded when it checked the receipt against its pinned key during the run." : " The Nightshift runtime's receipt key is pinned in <code>config/default.json</code>, so <strong>signature valid, key pinned</strong> shows the receipt was not changed and that this runtime signed it; a receipt signed by any other key stops the build."}</p>
${table("Model calls and their receipts", ["#", "Step", "Mode asked for", "Model that served it", "Receipt", "App", "Checked now", "At run time", "Time", "Tokens in / out"], callRows, { num: [0, 8, 9], id: [4] })}
      <p>The whole run passes the same check: ${c.run.receipts} receipts with valid signatures, ${c.run.calls} model calls in the trace that name a receipt, none missing and none naming a different model from its receipt.</p>
      <p class="muted">Signing key fingerprint (first 16 hex of SHA-256): ${[...new Set(receipts.map((x) => x.receipt?.keyFingerprint))].map((k) => `<code>${esc(k)}</code>`).join(", ")}.</p>

      <h2 id="queries">Zetaris queries</h2>
      <p>${querySource}</p>
${table("Zetaris reads in this run", ["Agent", "Table", "Rows", "Statement", "Query id"], queryRows, { num: [2], id: [4] })}

      <h2 id="check">Check it yourself</h2>
      <p>Clone the repository and run <code>npm run evidence:verify -- eval/runs/${esc(spec.runId)}</code>. ${c.meta.redacted ? `What the export left out: ${s(c.meta.redacted)}.` : ""}</p>`;
  return page(
    `${label.alert_id}: recorded run`,
    `Replay of the recorded run of alert ${label.alert_id}: every step, the model and receipt of each call, and the Zetaris reads.`,
    body,
  );
}

export function renderIndexPage(cases: Array<LoadedCase & { protect: Protected }>): string {
  const rows = cases.map((c) => [
    `<a href="${esc(c.spec.slug)}.html">${esc(c.label.alert_id)}</a>`,
    quotedText(c.label.title, c.spec, c.protect),
    esc(outcome(c.result.got)),
    esc(outcome(c.label.expected)),
    esc(verdictOf(c.label, c.result.got)),
    `${c.calls.filter((x) => x.receipt).length} of ${c.calls.length}`,
    `<code>${esc(c.spec.runId)}</code>`,
  ]);
  const body = `      <div class="page-head">
      <p class="crumbs"><a href="../index.html">Sanctions Desk</a> / Recorded runs</p>
      <h1>Recorded runs</h1>
      </div>
      <p class="measure">A few alerts from the committed run exports, shown step by step: which agent did what, which Nemotron model served each model call (local Lightning or cloud Ultra), the signed receipt for each call and whether it verifies, the Zetaris reads, and why a proposed close was stopped. The pages are built from the committed files by <code>npm run site:build</code>; the build stops if a receipt is missing or does not verify.</p>
      <p class="muted measure">Customers and payments are synthetic; listed parties are public sanctions-list entries. Customer notes, payment references and list remarks are not shown, apart from the characters of a span the screener flagged${
        cases.some((c) => c.spec.quote)
          ? ` and one phrase labelled synthetic on ${cases
              .filter((c) => c.spec.quote)
              .map((c) => esc(c.label.alert_id))
              .join(", ")}`
          : ""
      }, and identifier numbers are masked.</p>
      <p class="muted legend"><strong>Outcomes:</strong> ${esc(LEGEND)}</p>
${table("The recorded cases", ["Alert", "Case", "Desk recommendation", "Label", "Compared", "Calls with a verified receipt", "Run"], rows, { num: [5], id: [6] })}
      <ul class="links">
${cases.map((c) => `        <li><a href="${esc(c.spec.slug)}.html">${esc(c.label.alert_id)}</a>: ${esc(scrub(c.spec.shows, c.protect))}</li>`).join("\n")}
      </ul>`;
  return page(
    "Recorded runs",
    "Read-only replays of recorded Sanctions Desk runs: each step, the model that served each call, its verified receipt and the Zetaris reads.",
    body,
  );
}

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
  written.push("index.html");
  return written;
}

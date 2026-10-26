import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  BANNER,
  buildRunPages,
  flaggedSignals,
  loadRecordedCase,
  MAX_SPAN_CHARS,
  protectedValuesFor,
  RECORDED_CASES,
  REPO_URL,
  RecordedRunError,
  scrub,
  spanText,
  UNGROUNDED_SPANS_LABEL,
  WINDOW_WORDS,
  wordWindows,
} from "../../../tools/lib/runs-site.js";
import { FONT_FILES, FOOTER_LINKS, NAV_LINKS } from "../../../tools/lib/site-chrome.js";

const REPO_BLOB = `${REPO_URL}/blob/main/`;
/** What a page under site/runs/ may point at one level up: the stylesheet and the site's sections. */
const SITE_ROOT_FILES = new Set([
  "site.css",
  ...FONT_FILES,
  ...NAV_LINKS.map((l) => l.path),
  ...FOOTER_LINKS.map((l) => l.path),
]);
const out = mkdtempSync(join(tmpdir(), "desk-runs-"));
const scratch = mkdtempSync(join(tmpdir(), "desk-runs-tamper-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const written = buildRunPages(out);
const html = (f: string) => readFileSync(join(out, f), "utf8");
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: resolveProjectPath("."), encoding: "utf8" }).split("\0"),
);
const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const normalise = (s: string) =>
  decode(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

type Row = Record<string, unknown>;
const rows = (file: string): Row[] => JSON.parse(readFileSync(resolveProjectPath(file), "utf8")) as Row[];
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

describe("the recorded-run pages", () => {
  it("are generated for every chosen case, with an index, and every page loads the site's one stylesheet", () => {
    expect(RECORDED_CASES.length).toBeGreaterThanOrEqual(4);
    expect(RECORDED_CASES.length).toBeLessThanOrEqual(6);
    for (const c of RECORDED_CASES) {
      expect(written).toContain(`${c.slug}.html`);
      expect(html("index.html")).toContain(`href="${c.slug}.html"`);
    }
    expect(existsSync(resolveProjectPath("site/site.css"))).toBe(true);
    for (const f of written) {
      expect(html(f), f).toContain('href="../site.css"');
      expect(html(f), f).toContain('class="topbar"');
      expect(html(f), f).toContain('href="../receipts/index.html"');
    }
  });

  it("show the banner, the steps in order, every model call with its receipt id and its check", () => {
    for (const spec of RECORDED_CASES) {
      const page = html(`${spec.slug}.html`);
      const c = loadRecordedCase(spec);
      expect(page).toContain(BANNER);
      expect(page).toContain(`${REPO_BLOB}README.md#quick-start`);
      expect(page).toContain(c.label.expected);
      expect(page).toContain(c.result.got);
      // Steps in order: each step's agent and action appear, by sequence.
      let at = page.indexOf('id="steps"');
      for (const e of c.events) {
        const next = page.indexOf(
          `<td class="num">${e.seq}</td><td>${e.agent}</td><td><code>${e.action}</code></td>`,
          at,
        );
        expect(next, `${spec.slug} step ${e.seq}`).toBeGreaterThan(at);
        at = next;
      }
      const receipts = c.calls.filter((x) => x.receipt);
      expect(receipts.length).toBeGreaterThan(0);
      for (const x of receipts) expect(page).toContain(x.receipt?.id);
      expect(page).toMatch(/signature valid, key (from the receipt|pinned)/);
      expect(page).toMatch(/Lightning/);
    }
  });

  it("show the Zetaris statements as the sealed record keeps them, and why a close was stopped", () => {
    const page = decode(html("alr-0073.html"));
    expect(page).toContain("SELECT `alert_id`");
    expect(page).toContain("Why the close was stopped");
    expect(page).toContain("jurisdiction: block");
    expect(decode(html("alr-0043.html"))).toContain("critic_unresolved: block");
    expect(html("alr-0004.html")).toContain("Why the close stood");
  });

  it("never contain the case's free text or identifier numbers", () => {
    const customers = rows("data/synthetic/customer.json");
    const payments = rows("data/synthetic/payment.json");
    const alerts = rows("data/synthetic/alert.json");
    const custIds = rows("data/synthetic/customer_identifier.json");
    const entries = rows("data/sample/list_entry.json");
    const listIds = rows("data/sample/list_identifier.json");
    let checked = 0;
    for (const spec of RECORDED_CASES) {
      const { label } = loadRecordedCase(spec);
      const alert = alerts.find((a) => a.alert_id === label.alert_id);
      const free = [
        ...customers.filter((r) => r.customer_id === label.customer_id).map((r) => r.notes),
        ...payments
          .filter((r) => r.customer_id === label.customer_id || r.payment_id === alert?.payment_id)
          .map((r) => r.payment_reference),
        ...entries.filter((r) => r.entry_id === label.entry_id).map((r) => r.remarks),
      ].filter(text);
      const ids = [
        ...custIds.filter((r) => r.customer_id === label.customer_id).map((r) => r.id_number),
        ...listIds.filter((r) => r.entry_id === label.entry_id).map((r) => r.id_number),
      ].filter(text);
      for (const page of [html(`${spec.slug}.html`), html("index.html")]) {
        // A span the screener flagged is shown on purpose and checked on its own below. So is the one phrase a case
        // may quote in its description and case note: it must be exactly that case's allowed phrase, labelled synthetic.
        const quotes = [...page.matchAll(/<q class="case-quote">([^<]*)<\/q> \(synthetic\)/g)].map((m) =>
          decode(m[1] as string),
        );
        const allowed = RECORDED_CASES.filter(
          (r) => r.quote && (page === html(`${spec.slug}.html`) ? r === spec : true),
        ).map((r) => r.quote?.phrase as string);
        for (const q of quotes) expect(allowed, `${spec.slug}: quoted free text`).toContain(q);
        expect(page.split('class="case-quote"').length - 1, `${spec.slug}: unlabelled quote`).toBe(quotes.length);
        const flat = normalise(
          page.replace(/<q class="flagged-span">[^<]*<\/q>/g, " ").replace(/<q class="case-quote">[^<]*<\/q>/g, " "),
        );
        for (const v of free) {
          expect(flat, `${spec.slug}: free text`).not.toContain(v.replace(/\s+/g, " ").toLowerCase());
          for (const w of wordWindows(v))
            expect(flat, `${spec.slug}: ${WINDOW_WORDS} words of free text`).not.toContain(w.toLowerCase());
          checked += 1;
        }
        for (const id of ids.filter((x) => x.length >= 5)) {
          expect(flat, `${spec.slug}: identifier number`).not.toContain(id.toLowerCase());
          checked += 1;
        }
      }
    }
    // The chosen cases do carry free text (a payment reference, list remarks, a customer note) and identifiers.
    expect(checked).toBeGreaterThan(10);
  });

  it("show only the exact characters of a flagged span, and a line on what happened", () => {
    let spans = 0;
    for (const spec of RECORDED_CASES) {
      const c = loadRecordedCase(spec);
      const page = html(`${spec.slug}.html`);
      expect(page).toContain("What happened:");
      const shown = [...page.matchAll(/<q class="flagged-span">([^<]*)<\/q>/g)].map((m) => decode(m[1] as string));
      const p = protectedValuesFor(c.label);
      const expected = flaggedSignals(c.events)
        .map((sig) => spanText(sig, p))
        .filter((t): t is string => t !== undefined);
      expect(shown, spec.slug).toEqual(expected);
      for (const t of shown) expect(t.length).toBeLessThanOrEqual(MAX_SPAN_CHARS);
      spans += shown.length;
    }
    // ALR-L0001 quotes exactly one phrase of its synthetic customer note, word for word, in its description and note.
    const l1 = RECORDED_CASES.find((r) => r.slug === "alr-l0001");
    const note = rows("data/synthetic/customer.json").find((r) => r.customer_id === "CUST-L0001")?.notes as string;
    expect(note).toContain(l1?.quote?.phrase as string);
    const l1quotes = [...html("alr-l0001.html").matchAll(/<q class="case-quote">([^<]*)<\/q> \(synthetic\)/g)];
    expect(l1quotes.map((m) => decode(m[1] as string))).toEqual([l1?.quote?.phrase, l1?.quote?.phrase]);
    expect(RECORDED_CASES.filter((r) => r.quote).map((r) => r.slug)).toEqual(["alr-l0001"]);
    // ALR-L0001's screener flagged its customer note; that case shows its spans.
    expect(decode(html("alr-l0001.html"))).toContain("customer.notes characters");
    expect(spans).toBeGreaterThan(0);
  });

  it("label the recorded spans of ALR-L0001 as not grounded, directly above them, and no other page", () => {
    const l1 = html("alr-l0001.html");
    const c = loadRecordedCase(RECORDED_CASES.find((r) => r.slug === "alr-l0001") as (typeof RECORDED_CASES)[0]);
    const signals = flaggedSignals(c.events);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => !s.grounded)).toBe(true);
    const label = l1.indexOf(UNGROUNDED_SPANS_LABEL);
    const firstSpan = l1.indexOf('<q class="flagged-span">');
    expect(label).toBeGreaterThan(-1);
    expect(firstSpan).toBeGreaterThan(label);
    // Nothing else sits between the label and the list of spans.
    expect(l1.slice(label, firstSpan)).toMatch(/^[^<]*<\/strong><\/p>\s*<ul class="checks">\s*<li>[^<]*$/);
    // The label is only for spans the desk marked not grounded: a page whose shown spans are grounded has none.
    for (const spec of RECORDED_CASES.filter((r) => r.slug !== "alr-l0001")) {
      const page = html(`${spec.slug}.html`);
      const shown = flaggedSignals(loadRecordedCase(spec).events).filter(
        (s) => spanText(s, protectedValuesFor(loadRecordedCase(spec).label)) !== undefined,
      );
      const expectLabel = shown.length > 0 && shown.every((s) => !s.grounded);
      expect(page.includes(UNGROUNDED_SPANS_LABEL), spec.slug).toBe(expectLabel);
    }
  });

  it("have only links that resolve, call nothing and load nothing from outside", () => {
    for (const f of written.filter((x) => x.endsWith(".html"))) {
      const page = html(f);
      expect(page).not.toMatch(/<script|<iframe|localhost|127\.0\.0\.1/);
      for (const m of page.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        const link = m[1] as string;
        if (link.startsWith(REPO_BLOB)) {
          expect(tracked.has(link.slice(REPO_BLOB.length).split("#")[0] as string), `${f}: ${link}`).toBe(true);
        } else if (link === REPO_URL) {
        } else if (link.startsWith("../")) {
          expect(SITE_ROOT_FILES.has(link.slice(3)), `${f}: ${link}`).toBe(true);
        } else if (link.startsWith("#")) {
          expect(page, `${f}: ${link}`).toContain(`id="${link.slice(1)}"`);
        } else {
          expect(/^[a-z]+:/i.test(link), `${f}: ${link}`).toBe(false);
          expect(existsSync(join(out, link.split("#")[0] as string)), `${f}: ${link}`).toBe(true);
        }
      }
    }
  });
});

describe("scrub", () => {
  const p = {
    freeText: ["Machine parts, onward delivery to Tehran by road"],
    idNumbers: ["C98720542"],
    names: ["Tehran Trading"],
  };
  it("withholds whole values, quoted parts and runs of words, and masks identifier numbers", () => {
    expect(scrub("ref: Machine parts, onward delivery to Tehran by road", p)).not.toMatch(/Machine parts/);
    expect(scrub('the reference mentions "Tehran"', p)).toBe('the reference mentions "[free text withheld]"');
    expect(scrub("it said onward delivery to Tehran soon", p)).not.toMatch(/onward delivery to Tehran/);
    expect(scrub("passport C98720542 checked", p)).toBe("passport [id number masked] checked");
    expect(scrub("nothing to hide here", p)).toBe("nothing to hide here");
  });
});

describe("the build", () => {
  const spec = RECORDED_CASES[0];
  if (!spec) throw new Error("no recorded case");
  const fresh = () => {
    const runs = mkdtempSync(join(scratch, "runs-"));
    cpSync(resolveProjectPath(`eval/runs/${spec.runId}`), join(runs, spec.runId), { recursive: true });
    // The documented changes to exported files travel with the runs.
    cpSync(resolveProjectPath("eval/runs/HASH-CHANGES.json"), join(runs, "HASH-CHANGES.json"));
    return runs;
  };
  const receiptOf = () => loadRecordedCase(spec).calls.find((c) => c.receipt)?.receipt?.id as string;
  /** Rewrite receipts.jsonl.gz and its hash in run-meta.json, so only the receipt check can catch the change. */
  const rewriteReceipts = (runs: string, change: (lines: string[]) => string[]) => {
    const dir = join(runs, spec.runId);
    const file = join(dir, "receipts.jsonl.gz");
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
    writeFileSync(file, gzipSync(`${change(lines).join("\n")}\n`));
    const meta = JSON.parse(readFileSync(join(dir, "run-meta.json"), "utf8"));
    meta.files["receipts.jsonl.gz"].sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    writeFileSync(join(dir, "run-meta.json"), JSON.stringify(meta));
  };
  const build = (runsDir: string) => () =>
    buildRunPages(mkdtempSync(join(scratch, "out-")), { runsDir, cases: [spec] });

  it("builds from an untouched copy", () => {
    expect(build(fresh())()).toContain(`${spec.slug}.html`);
  });

  it("fails when a run file is missing", () => {
    const runs = fresh();
    unlinkSync(join(runs, spec.runId, "trace.jsonl.gz"));
    expect(build(runs)).toThrow(RecordedRunError);
  });

  it("fails when a receipt the trace names is missing", () => {
    const runs = fresh();
    const id = receiptOf();
    rewriteReceipts(runs, (lines) => lines.filter((l) => !l.includes(`"receipt_id":"${id}"`)));
    expect(build(runs)).toThrow(/is not in receipts\.jsonl\.gz/);
  });

  it("fails when a receipt was changed after it was signed", () => {
    const runs = fresh();
    const id = receiptOf();
    rewriteReceipts(runs, (lines) =>
      lines.map((l) => {
        if (!l.includes(`"receipt_id":"${id}"`)) return l;
        const env = JSON.parse(l);
        env.body.receipt.app = "changed-after-signing";
        return JSON.stringify(env);
      }),
    );
    expect(build(runs)).toThrow(/does not verify \(invalid/);
  });

  it("fails when a run file no longer matches the hash its export recorded", () => {
    const runs = fresh();
    const file = join(runs, spec.runId, "trace.jsonl.gz");
    writeFileSync(
      file,
      gzipSync(gunzipSync(readFileSync(file)).toString("utf8").replace("model_answer", "model_answr")),
    );
    expect(build(runs)).toThrow(/does not match the sha256/);
  });
});

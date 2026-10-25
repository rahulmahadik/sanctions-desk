import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  projectRoot,
  RECEIPT_VERIFICATION,
  type ReceiptVerification,
  resolveProjectPath,
  verifyReceipt,
} from "@sanctions-desk/shared";

/**
 * Every signed receipt committed under eval/, verified against the pinned key, with what the docs report from them:
 * Nightshift's own cross-check and any answer memory it added, per set (exported runs, studies, anything else).
 */
export function scanReceipts(trusted: readonly string[]) {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /^receipts\.jsonl(\.gz)?$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  interface Receipt {
    body?: {
      receipt?: {
        cross_check?: { status?: string; checks?: Array<{ status?: string; type?: string }> };
        egress?: { sent?: { context_sources?: unknown[] } };
      };
    };
  }

  interface Group {
    receipts: number;
    folders: number;
    with_added_memory: number;
    cross_check: Record<string, number>;
    /** The kinds of check that raised Nightshift's warnings, with how many receipts each. */
    cross_check_warnings: Record<string, number>;
  }
  const group = (): Group => ({
    receipts: 0,
    folders: 0,
    with_added_memory: 0,
    cross_check: {},
    cross_check_warnings: {},
  });
  const groups: Record<"runs" | "studies" | "elsewhere", Group> = {
    runs: group(),
    studies: group(),
    elsewhere: group(),
  };
  const bump = (m: Record<string, number>, k: string) => {
    m[k] = (m[k] ?? 0) + 1;
  };

  const empty = () =>
    Object.fromEntries(RECEIPT_VERIFICATION.map((s) => [s, 0])) as Record<ReceiptVerification, number>;
  const total = empty();
  const perFile: Array<{ file: string; receipts: number } & Record<string, number | string>> = [];
  for (const file of files(resolveProjectPath("eval")).sort()) {
    const raw = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    const path = relative(projectRoot(), file);
    const g =
      groups[path.startsWith("eval/runs/") ? "runs" : path.startsWith("eval/studies/") ? "studies" : "elsewhere"];
    const counts = empty();
    for (const line of text.split("\n").filter(Boolean)) {
      const envelope = JSON.parse(line) as Receipt;
      counts[verifyReceipt(envelope, trusted).status] += 1;
      const r = envelope.body?.receipt;
      bump(g.cross_check, r?.cross_check?.status ?? "none");
      if (r?.cross_check?.status === "warning")
        for (const c of r.cross_check.checks ?? [])
          if (c.status === "warning") bump(g.cross_check_warnings, c.type ?? "unnamed");
      if ((r?.egress?.sent?.context_sources ?? []).some((s) => String(s).startsWith("hmem:"))) g.with_added_memory += 1;
    }
    for (const s of RECEIPT_VERIFICATION) total[s] += counts[s];
    const receipts = Object.values(counts).reduce((a, b) => a + b, 0);
    g.receipts += receipts;
    g.folders += 1;
    perFile.push({ file: path, receipts, ...counts });
  }
  const receipts = Object.values(total).reduce((a, b) => a + b, 0);
  const result = {
    pinned_keys: trusted,
    files: perFile.length,
    receipts,
    from_runs: groups.runs.receipts,
    from_studies: groups.studies.receipts,
    from_elsewhere: groups.elsewhere.receipts,
    ...total,
    groups,
    per_file: perFile,
  };
  return result;
}

/** The sentence the docs and the proof use for the total. */
export const receiptsLine = (r: {
  receipts: number;
  from_runs: number;
  from_studies: number;
  valid_pinned: number;
}) => {
  const n = (x: number) => x.toLocaleString("en-US");
  const how =
    r.valid_pinned === r.receipts
      ? "all verified against the pinned key"
      : `${n(r.valid_pinned)} verified against the pinned key`;
  return `${n(r.receipts)} signed receipts: ${n(r.from_runs)} from exported runs, ${n(r.from_studies)} from studies, ${how}`;
};

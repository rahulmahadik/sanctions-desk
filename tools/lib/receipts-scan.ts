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

/** The folder of the fully local mode study (npm run study:local-mode), whose receipts are reported on their own line. */
export const LOCAL_MODE_DIR = "eval/studies/local-mode/";

export interface ReceiptGroup {
  receipts: number;
  valid_pinned: number;
  folders: number;
  with_added_memory: number;
  cross_check: Record<string, number>;
  /** The kinds of check that raised Nightshift's warnings, with how many receipts each. */
  cross_check_warnings: Record<string, number>;
}

/**
 * Every signed receipt committed under eval/, verified against the pinned key, with what the docs report from them:
 * Nightshift's own cross-check and any answer memory it added, per set (exported runs, the small studies, the fully
 * local mode study, anything else). Every receipt is verified; the headline the docs quote is every receipt but the
 * fully local study's, which the docs report separately as part of that study.
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

  const group = (): ReceiptGroup => ({
    receipts: 0,
    valid_pinned: 0,
    folders: 0,
    with_added_memory: 0,
    cross_check: {},
    cross_check_warnings: {},
  });
  const groups: Record<"runs" | "studies" | "local_mode" | "elsewhere", ReceiptGroup> = {
    runs: group(),
    studies: group(),
    local_mode: group(),
    elsewhere: group(),
  };
  const groupOf = (path: string): keyof typeof groups =>
    path.startsWith("eval/runs/")
      ? "runs"
      : path.startsWith(LOCAL_MODE_DIR)
        ? "local_mode"
        : path.startsWith("eval/studies/")
          ? "studies"
          : "elsewhere";
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
    const g = groups[groupOf(path)];
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
    g.valid_pinned += counts.valid_pinned;
    g.folders += 1;
    perFile.push({ file: path, receipts, ...counts });
  }
  const receipts = Object.values(total).reduce((a, b) => a + b, 0);
  const result = {
    pinned_keys: trusted,
    files: perFile.length,
    /** Every receipt under eval/, the fully local study's included; the verification counts below cover them all. */
    receipts,
    /** The figure the docs quote: every receipt but the fully local study's (reported on their own line). */
    headline: receipts - groups.local_mode.receipts,
    from_runs: groups.runs.receipts,
    from_studies: groups.studies.receipts,
    from_local_mode: groups.local_mode.receipts,
    from_elsewhere: groups.elsewhere.receipts,
    ...total,
    groups,
    per_file: perFile,
  };
  return result;
}

export type ReceiptScan = ReturnType<typeof scanReceipts>;

const n = (x: number) => x.toLocaleString("en-US");

/** The sentence the docs and the proof use for the headline total (the fully local study's receipts are not in it). */
export const receiptsLine = (r: {
  receipts: number;
  headline: number;
  from_runs: number;
  from_studies: number;
  valid_pinned: number;
}) => {
  const how =
    r.valid_pinned === r.receipts
      ? "all verified against the pinned key"
      : `${n(r.valid_pinned)} verified against the pinned key`;
  return `${n(r.headline)} signed receipts: ${n(r.from_runs)} from exported runs, ${n(r.from_studies)} from studies, ${how}`;
};

/** The one line the docs give the fully local study's receipts, beside the headline wherever that is quoted. */
export const localModeLine = (r: { from_local_mode: number; groups: { local_mode: { valid_pinned: number } } }) => {
  if (r.from_local_mode === 0) return "Fully local study (A3): no receipts exported yet.";
  const how =
    r.groups.local_mode.valid_pinned === r.from_local_mode
      ? "all verified against the pinned key"
      : `${n(r.groups.local_mode.valid_pinned)} verified against the pinned key`;
  return `Fully local study (A3): ${n(r.from_local_mode)} signed receipts, ${how}.`;
};

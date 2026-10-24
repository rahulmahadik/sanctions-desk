/**
 * Review every alert in the sample data, in process, with a fixed clock and the labelled rules stand-in, and write
 * each alert's answer and a digest of its sealed record. The digest leaves out what differs on every run by design:
 * the random Zetaris query ids and the hashes that cover them. Run it before and after a change that must not alter the default
 * review: the two files are identical, or the change altered an answer or a record.
 *
 *   npm run gate:sample -- --out before.json
 *   npm run gate:sample -- --out after.json && cmp before.json after.json
 *   npm run gate:sample -- --with-env --out env.json   the same, with the local configuration (e.g. step tokens)
 *
 * Nothing live is touched: Zetaris answers come from the committed sample cache and no model is called.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAlertQueue, runReview, sampleRules } from "@sanctions-desk/agents";
import {
  createFallbackRulesGenerator,
  createTraceLogger,
  loadConfig,
  loadPolicyFile,
  resolveProjectPath,
} from "@sanctions-desk/shared";
import { createZetarisClient, loadQueryCache, replayFetch } from "@sanctions-desk/zetaris";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? resolve(process.argv[i + 1] as string) : undefined;
const logDir = mkdtempSync(join(tmpdir(), "sample-gate-"));
// --with-env: read the local configuration too (for example per-step Zetaris tokens), still in sample mode.
const withEnv = process.argv.includes("--with-env");
if (withEnv && existsSync(resolveProjectPath(".env"))) process.loadEnvFile(resolveProjectPath(".env"));
const base = loadConfig({ env: withEnv ? { ...process.env, SAMPLE_MODE: "true" } : { SAMPLE_MODE: "true" } });
const config = { ...base, logging: { ...base.logging, dir: logDir, stdout: false } };
const zetaris = createZetarisClient({
  config,
  offline: true,
  fetchImpl: replayFetch(loadQueryCache(resolveProjectPath(config.sampleCache))),
});
const policy = loadPolicyFile(config.policy.file);
const now = () => new Date("2026-10-25T00:00:00.000Z");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIES = new Set(["query_id", "zetaris_query_id", "record_hash", "previous_record_hash", "body_hash"]);
/** The record with the per-run random parts removed, as sorted-key JSON. */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => !VARIES.has(k))
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return typeof v === "string" && UUID.test(v) ? '"<id>"' : JSON.stringify(v);
};
const digestOf = (runDir: string, recordHash: string): string => {
  const dir = join(runDir, "records");
  for (const f of readdirSync(dir)) {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { record_hash?: string };
    if (rec.record_hash !== recordHash) continue;
    return createHash("sha256").update(stable(rec)).digest("hex");
  }
  throw new Error(`no sealed record with hash ${recordHash}`);
};

const rows: Array<{ alert_id: string; decision: string; confidence: number; record_digest: string }> = [];
try {
  const queue = await readAlertQueue({ zetaris, config });
  for (const item of queue) {
    const runId = `gate-${item.alert_id}`;
    let res!: Awaited<ReturnType<typeof runReview>>;
    try {
      res = await runReview(
        {
          config,
          policy,
          zetaris,
          generator: createFallbackRulesGenerator(sampleRules),
          trace: createTraceLogger({ runId, dir: logDir, stdout: false }),
          now,
          sleep: async () => {},
        },
        { runId, alertId: item.alert_id, sampleMode: true, sampleNotice: "sample gate" },
      );
    } catch (err) {
      // An alert the sample cache cannot answer fails the same way in the desk; the failure is part of the answer.
      const type = (err as { type?: string }).type ?? "error";
      rows.push({ alert_id: item.alert_id, decision: `ERROR ${type}`, confidence: 0, record_digest: "" });
      continue;
    }
    const r = res as unknown as { decision: string; confidence: number; record_hash: string };
    rows.push({
      alert_id: item.alert_id,
      decision: r.decision,
      confidence: r.confidence,
      record_digest: digestOf(logDir, r.record_hash),
    });
  }
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
const text = `${JSON.stringify(rows, null, 2)}\n`;
if (out) writeFileSync(out, text);
const counts = rows.reduce<Record<string, number>>((m, r) => {
  m[r.decision] = (m[r.decision] ?? 0) + 1;
  return m;
}, {});
console.log(`${rows.length} sample alerts reviewed: ${JSON.stringify(counts)}${out ? `; written to ${out}` : ""}`);

/**
 * A small, labelled lab outside the exam: does an explicit model id pin the model that serves a call, and does that
 * depend on the request headers? Each model id is sent with four header sets (the ones we send now, plus an Accept
 * header, plus a User-Agent header, plus both), on an app identity that is not bound in the cockpit. The exact headers
 * of every call are written to the result (the token is shown as <token>), and the served model is read from the call's
 * own signed receipt.
 *
 *   npm run lab:pinning -- --out eval/pinning-lab.json [--reps 3] [--app sanctions-desk-lab] [--dry-run]
 *
 * It writes nothing to Zetaris and changes no cockpit setting. Run it only when no exam is running.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";

if (existsSync(resolveProjectPath(".env"))) process.loadEnvFile(resolveProjectPath(".env"));
const config = loadConfig();
const base = config.nightshift.baseUrl.replace(/\/$/, "");
const token = config.nightshift.runtimeToken?.reveal();
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const app = arg("--app") ?? "sanctions-desk-lab";
const reps = Number(arg("--reps") ?? 3);
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
const LIGHTNING = "local-runtime/nemotron-3.5-lightning-30b-a3b";

const HEADER_SETS: Array<{ name: string; extra: Record<string, string> }> = [
  { name: "ours", extra: {} },
  { name: "+accept", extra: { accept: "application/json" } },
  {
    name: "+user-agent",
    extra: { "user-agent": "sanctions-desk/1.0 (review desk)" },
  },
  { name: "+both", extra: { accept: "application/json", "user-agent": "sanctions-desk/1.0" } },
];
const plan = [LIGHTNING, ULTRA].flatMap((model) =>
  HEADER_SETS.map((h) => ({ model, header_set: h.name, extra: h.extra })),
);

const headersFor = (extra: Record<string, string>) => ({
  authorization: "Bearer <token>",
  "content-type": "application/json",
  "meterless-app": app,
  "meterless-scope": config.nightshift.scope,
  ...extra,
});

if (process.argv.includes("--dry-run")) {
  for (const p of plan) console.log(`${p.model} [${p.header_set}] ${JSON.stringify(headersFor(p.extra))}`);
  console.log(`${plan.length * reps} calls (nothing sent)`);
  process.exit(0);
}
if (!token) throw new Error("the Nightshift runtime token is not set");

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const rows: unknown[] = [];
for (const p of plan) {
  for (let i = 0; i < reps; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    const started = performance.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { ...headersFor(p.extra), authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: p.model,
          max_tokens: 24,
          temperature: 0,
          messages: [
            { role: "user", content: `Pinning lab ${randomBytes(6).toString("hex")}. Reply with the single word OK.` },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = rec(await res.json().catch(() => ({})));
      const m = rec(body.meterless);
      const receipt = rec(rec(rec(m.receipt_envelope).body).receipt);
      const served = rec(receipt.winning_route).model ?? m.routed_model;
      rows.push({
        asked: p.model,
        header_set: p.header_set,
        headers_sent: headersFor(p.extra),
        status: res.status,
        ms: Math.round(performance.now() - started),
        served,
        pinned: served === p.model,
        mode_coerced: rec(receipt.app_policy).mode_coerced,
        routed_mode: rec(receipt.app_policy).routed_mode,
        error: rec(body.error).message,
      });
      console.log(
        `${p.header_set.padEnd(12)} asked ${p.model} -> served ${String(served)} pinned=${served === p.model}`,
      );
    } catch (err) {
      rows.push({ asked: p.model, header_set: p.header_set, error: String(err).slice(0, 160) });
      console.log(`${p.header_set} ${p.model} error ${String(err).slice(0, 100)}`);
    }
  }
}
const out = arg("--out");
if (out)
  writeFileSync(
    resolveProjectPath(out),
    `${JSON.stringify({ label: "pinning lab, not part of the exam", at: new Date().toISOString(), app, rows }, null, 2)}\n`,
  );

/**
 * A small, labelled lab for the routing questions, kept outside the exam: which model serves a call when the request
 * names a mode, a real model id, or comes from different app identities. Each call is a one-word prompt with a
 * nonce, so no answer is served from the cache, and the result is read from the call's own receipt.
 *
 *   npm run lab:routing -- --out eval/routing-lab.json
 *
 * It writes nothing to Zetaris and changes no cockpit setting. The identities named here are created in the
 * runtime's app list by the first request, with whatever the cockpit gives a new app.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { loadConfig, resolveProjectPath } from "@sanctions-desk/shared";

if (existsSync(resolveProjectPath(".env"))) process.loadEnvFile(resolveProjectPath(".env"));
const config = loadConfig();
const base = config.nightshift.baseUrl.replace(/\/$/, "");
const token = config.nightshift.runtimeToken?.reveal();
if (!token) throw new Error("the Nightshift runtime token is not set");

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const out = arg("--out");
const reps = Number(arg("--reps") ?? 3);

interface Probe {
  app: string;
  model: string;
}
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
const LIGHTNING = "local-runtime/nemotron-3.5-lightning-30b-a3b";
const only = arg("--only");
const allProbes: Probe[] = [
  { app: "", model: "meterless/local" },
  { app: "", model: LIGHTNING },
  { app: "", model: ULTRA },
  { app: "", model: "meterless/deep" },
  { app: "sanctions-desk-lab", model: "meterless/deep" },
  { app: "sanctions-desk-lab", model: "meterless/fast" },
  { app: "sanctions-desk-lab", model: ULTRA },
  { app: "sanctions-desk-lab", model: LIGHTNING },
  { app: "sanctions-desk", model: ULTRA },
  { app: "sanctions-desk", model: LIGHTNING },
  ...(arg("--apps")?.split(",") ?? []).flatMap((app) => [
    { app, model: "meterless/deep" },
    { app, model: "meterless/fast" },
  ]),
];

const probes =
  only === "default"
    ? allProbes.filter((p) => p.app === "")
    : only === "apps"
      ? allProbes.filter((p) => p.app.endsWith("-reasoning") || p.app.endsWith("-guard"))
      : allProbes;
const num = (x: unknown) => (typeof x === "number" ? x : undefined);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

async function call(p: Probe, i: number) {
  const started = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // An empty app name sends no app header, which the runtime treats as its unbound "default" app.
      ...(p.app === "" ? {} : { "meterless-app": p.app, "meterless-scope": config.nightshift.scope }),
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: Number(arg("--max-tokens") ?? 24),
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Routing lab ${randomBytes(6).toString("hex")} call ${i}. Reply with the single word OK.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    return { ...p, status: res.status, error: text.slice(0, 160) };
  }
  const m = rec(body.meterless);
  const receipt = rec(rec(rec(m.receipt_envelope).body).receipt);
  const policy = rec(receipt.app_policy);
  return {
    ...p,
    status: res.status,
    ms: Math.round(performance.now() - started),
    asked: p.model,
    body_model: body.model,
    routed_model: m.routed_model,
    route_kind: rec(m.winning_route).kind,
    from_cache: m.from_cache,
    app_policy: {
      requested_mode: policy.requested_mode,
      routed_mode: policy.routed_mode,
      mode_coerced: policy.mode_coerced,
      lanes: policy.lanes,
      has_rule: policy.has_rule,
    },
    receipt_app: receipt.app,
    receipt_winning_model: rec(receipt.winning_route).model,
    tokens: num(rec(body.usage).total_tokens),
    error: rec(body.error).message,
  };
}

const rows: unknown[] = [];
for (const p of probes) {
  for (let i = 0; i < reps; i += 1) {
    try {
      await new Promise((r) => setTimeout(r, Number(arg("--pace") ?? 2500)));
      const row = await call(p, i);
      rows.push(row);
      const r = row as Record<string, unknown>;
      console.log(
        `${p.app.padEnd(24)} ${p.model.padEnd(52)} -> ${String(r.route_kind ?? r.error)} ${String(r.routed_model ?? "")} coerced=${String(rec(r.app_policy).mode_coerced)} ${String(r.ms ?? "")}ms`,
      );
    } catch (e) {
      console.log(`${p.app} ${p.model} error ${String(e).slice(0, 100)}`);
    }
  }
}
if (out)
  writeFileSync(
    resolveProjectPath(out),
    `${JSON.stringify({ label: "routing lab, not part of the exam", at: new Date().toISOString(), rows }, null, 2)}\n`,
  );

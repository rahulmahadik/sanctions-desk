/**
 * The sign-in and role checks against the live stack: the real API, built the way the server builds it in live mode
 * (real Zetaris and Nightshift clients, sign-in on), listening on a spare port on 127.0.0.1, with a throwaway users
 * file in a temporary folder. No review is started and no model is called: the decision checks use a copy of a sealed
 * live record, and the rate-limit check sends requests that fail validation after they are counted.
 *
 *   npm run check:auth-live -- --record logs/records/rec-ui-ALR-0073-1792870820973.json
 *
 * Writes eval/security/live-auth-<date>.json: each check, the status expected and the status received. No token is
 * written anywhere; the tokens live only in this process.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { changeUsers, loadConfig, projectRoot, resolveProjectPath } from "@sanctions-desk/shared";
import pino from "pino";
import { buildApp } from "../apps/api/src/app.js";
import { buildRuntime } from "../apps/api/src/runtime.js";

for (const name of [".env", ".env.data"]) {
  const file = join(projectRoot(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const recordFile = resolveProjectPath(arg("--record") ?? "logs/records/rec-ui-ALR-0073-1792870820973.json");
const record = JSON.parse(readFileSync(recordFile, "utf8")) as {
  alert_ref: string;
  record_hash: string;
  decision: string;
};

const work = mkdtempSync(join(tmpdir(), "desk-auth-live-"));
const logDir = join(work, "logs");
mkdirSync(join(logDir, "records"), { recursive: true });
copyFileSync(recordFile, join(logDir, "records", basename(recordFile)));
const usersFile = join(work, "users.json");
const token = (id: string, role: "viewer" | "analyst" | "approver" | "policy_admin") =>
  changeUsers(usersFile, { action: "add", id, role, by: "check-auth-live" }).token as string;
const tokens = {
  viewer: token("live_viewer", "viewer"),
  analyst: token("live_analyst", "analyst"),
  approver: token("live_approver", "approver"),
  approver2: token("live_approver2", "approver"),
  writer: token("live_writer", "analyst"),
};

const base = loadConfig();
if (base.sampleMode) throw new Error("this check is for the live stack: unset SAMPLE_MODE");
const config = {
  ...base,
  server: {
    ...base.server,
    host: "127.0.0.1",
    port: 0,
    auth: "on" as const,
    usersFile,
    rateLimit: { ...base.server.rateLimit, enabled: true, writesPerWindow: 3, reviewsPerWindow: 2 },
  },
  logging: { ...base.logging, dir: logDir, stdout: false },
  actions: { ...base.actions, outboxDir: join(work, "outbox") },
};
const logger = pino({ level: "silent" });
const app = await buildApp({ config, logger, ...buildRuntime(config, logger) });
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as { port: number }).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

interface Check {
  check: string;
  request: string;
  expected: number;
  received: number;
  error_type?: string;
  message?: string;
  pass: boolean;
}
const checks: Check[] = [];
async function call(
  check: string,
  method: string,
  path: string,
  opts: { as?: string; body?: unknown },
  expected: number,
) {
  const res = await fetch(url(path), {
    method,
    headers: {
      ...(opts.as ? { authorization: `Bearer ${opts.as}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
  const c: Check = {
    check,
    request: `${method} ${path}`,
    expected,
    received: res.status,
    ...(json.error ? { error_type: json.error.type, message: json.error.message } : {}),
    pass: res.status === expected,
  };
  checks.push(c);
  console.log(`${c.pass ? "PASS" : "FAIL"} ${check}: ${method} ${path} -> ${res.status} (expected ${expected})`);
  return c;
}

const alert = record.alert_ref;
const hash = record.record_hash;
try {
  await call("health is public", "GET", "/health", {}, 200);
  await call("no token", "GET", "/alerts", {}, 401);
  await call("a token not in the issued form", "GET", "/alerts", { as: "not-a-real-token" }, 401);
  await call("a well-formed token that is not in the file", "GET", "/alerts", { as: `sd_${"A".repeat(32)}` }, 401);
  await call("viewer reads", "GET", "/alerts", { as: tokens.viewer }, 200);
  await call(
    "wrong role: a viewer starts a review",
    "POST",
    "/run",
    { as: tokens.viewer, body: { alert_id: alert } },
    403,
  );
  await call(
    "wrong role: a viewer records a decision",
    "POST",
    `/cases/${alert}/decision`,
    { as: tokens.viewer, body: { action: "approve", reason: "viewer tries to decide", record_hash: hash } },
    403,
  );
  await call(
    "wrong role: an analyst overrides towards a close",
    "POST",
    `/cases/${alert}/decision`,
    {
      as: tokens.analyst,
      body: {
        action: "override",
        outcome: "CLOSE_FALSE_POSITIVE",
        reason: "analyst tries to close it",
        record_hash: hash,
      },
    },
    403,
  );
  await call(
    "an approver overrides an escalation to a close: it waits for a second approver",
    "POST",
    `/cases/${alert}/decision`,
    {
      as: tokens.approver,
      body: {
        action: "override",
        outcome: "CLOSE_FALSE_POSITIVE",
        reason: "live auth check: override to close",
        record_hash: hash,
      },
    },
    201,
  );
  // A decision is added to the sealed record, so its hash changes: the second approver confirms what they now see.
  const view = (await (
    await fetch(url(`/cases/${alert}/human`), { headers: { authorization: `Bearer ${tokens.approver2}` } })
  ).json()) as { record_hash: string; status: string };
  checks.push({
    check: "the case now waits for a second approver",
    request: `GET /cases/${alert}/human`,
    expected: 200,
    received: view.status === "override_pending" ? 200 : 0,
    message: `status ${view.status}`,
    pass: view.status === "override_pending",
  });
  await call(
    "four-eyes: the same approver gives the second approval",
    "POST",
    `/cases/${alert}/second-approval`,
    {
      as: tokens.approver,
      body: { approve: true, reason: "same person tries to confirm", record_hash: view.record_hash },
    },
    403,
  );
  await call(
    "four-eyes: a different approver declines the close",
    "POST",
    `/cases/${alert}/second-approval`,
    {
      as: tokens.approver2,
      body: { approve: false, reason: "second approver declines the close", record_hash: view.record_hash },
    },
    201,
  );
  // Writes are counted before their body is checked: three are let through (and refused as invalid), the fourth is 429.
  for (let i = 1; i <= 3; i++)
    await call(`rate limit: write ${i} of 3`, "POST", "/guard/outbound", { as: tokens.writer, body: {} }, 400);
  await call("rate limit: one write over the limit", "POST", "/guard/outbound", { as: tokens.writer, body: {} }, 429);
  changeUsers(usersFile, { action: "revoke", id: "live_viewer", by: "check-auth-live" }, new Date(Date.now() + 2000));
  await call("a revoked token, on the next request", "GET", "/alerts", { as: tokens.viewer }, 401);
} finally {
  await app.close();
}

const outDir = resolveProjectPath("eval/security");
mkdirSync(outDir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const out = join(outDir, `live-auth-${day}.json`);
const result = {
  at: new Date().toISOString(),
  stack:
    "the API built as in live mode (real Zetaris and Nightshift clients, sign-in on), on 127.0.0.1, throwaway users",
  record: `the sealed live record ${basename(recordFile)} (${alert}, recommendation ${record.decision}), copied into a temporary folder`,
  rate_limit: "writes per window set to 3 for this check",
  passed: checks.filter((c) => c.pass).length,
  total: checks.length,
  checks,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const text = readFileSync(out, "utf8");
if (Object.values(tokens).some((t) => text.includes(t))) throw new Error("a token reached the result file");
rmSync(work, { recursive: true, force: true });
console.log(`${result.passed} of ${result.total} checks passed; written ${out}`);
process.exit(result.passed === result.total ? 0 : 1);

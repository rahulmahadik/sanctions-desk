/**
 * Create the three runtime users in Zetaris (one per role) with an API token each, so no agent needs the admin key.
 *
 *   npm run zetaris:agents                    list what would be done
 *   npm run zetaris:agents -- --apply         create the users, assign their roles, issue the tokens
 *   npm run zetaris:agents -- --steps [--apply]   the optional per-step users only (USL_STEP_ROLES); the three
 *                                                 identities above are not touched. Their roles come from
 *                                                 zetaris/sql/10_step_roles_create.sql, applied first.
 *
 * Any earlier copy of a user is dropped (its password is unknown, so it could not sign in). The new user gets a random
 * password held only in memory; its API key is written to `.env`. Neither the password nor the key is printed or
 * logged. The admin key is read from the environment and used here only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot } from "@sanctions-desk/shared";
import { USL_AGENT_USERS, USL_STEP_ROLES } from "@sanctions-desk/zetaris";

const apply = process.argv.includes("--apply");
const steps = process.argv.includes("--steps");
const users: ReadonlyArray<{ name: string; email: string; role: string; tokenEnv: string }> = steps
  ? USL_STEP_ROLES.map((r) => ({ name: r.name, email: r.email, role: r.role, tokenEnv: r.tokenEnv }))
  : USL_AGENT_USERS;
const envPath = join(projectRoot(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
const { zetaris } = loadConfig();
if (!zetaris.apiKey) throw new Error("ZETARIS_API_KEY is not set");

const uiUrl = (process.env.ZETARIS_UI_URL ?? "http://localhost:3000").replace(/\/$/, "");
const KEY_DAYS = 90;
const admin = {
  Authorization: `Bearer ${zetaris.apiKey.reveal()}`,
  "X-Org-ID": String(zetaris.orgId),
  "content-type": "application/json",
};
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`${zetaris.restUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

/** Run one administrative SQL statement (DROP USER, ASSIGN USER) with the admin key. */
async function sql(statement: string): Promise<void> {
  const res = await call("POST", "/sql-editor/sqls/run", admin, {
    queryId: randomUUID(),
    sql: statement,
    source: "SqlEditor",
    limit: 10,
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { msg?: string }).msg ?? "";
    throw new Error(
      `${statement.split(" ").slice(0, 2).join(" ")} failed (HTTP ${res.status}) ${msg.split("\n")[0]?.slice(0, 120)}`,
    );
  }
}

/** Put NAME=value in .env, replacing any earlier line, without printing the value. */
function saveToken(name: string, value: string): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else {
    if (lines.at(-1) === "") lines.pop();
    lines.push(`${name}=${value}`, "");
  }
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
}

/** The key is in whichever string field of the answer is long enough to be one. */
function keyOf(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer.length >= 16 ? answer : undefined;
  if (answer && typeof answer === "object") {
    for (const v of Object.values(answer)) {
      const found = keyOf(v);
      if (found) return found;
    }
  }
  return undefined;
}

const existing = (await (await call("GET", "/users", admin)).json()) as Array<{ email: string }>;
const known = new Set(existing.map((u) => u.email.toLowerCase()));

for (const u of users) {
  const exists = known.has(u.email.toLowerCase());
  console.log(`${u.email}: ${exists ? "replace" : "create"}, role ${u.role}, token ${u.tokenEnv}`);
  if (!apply) continue;

  if (exists) await sql(`DROP USER '${u.email}'`);
  const password = `${randomBytes(18).toString("base64url")}Aa1!`;
  const created = await call("POST", "/users", admin, {
    email: u.email,
    name: u.name,
    level: "GENERAL",
    password,
    isLdap: false,
  });
  if (!created.ok) throw new Error(`could not create ${u.email} (HTTP ${created.status})`);
  await sql(`ASSIGN USER '${u.email}' TO ROLE '${u.role}'`);

  const login = await fetch(`${uiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u.email, password }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!login.ok) throw new Error(`${u.email} could not sign in (HTTP ${login.status})`);
  const session = (await login.json()) as { idToken?: string; orgId?: string | number };
  if (!session.idToken) throw new Error(`${u.email}: the sign-in gave no session`);

  const expiry = new Date(Date.now() + KEY_DAYS * 86_400_000).toISOString();
  const issued = await call(
    "POST",
    "/auth/api-key",
    {
      Authorization: `Bearer ${session.idToken}`,
      "X-Org-ID": String(session.orgId ?? zetaris.orgId),
      "content-type": "application/json",
    },
    { name: `sanctions-desk ${u.name}`, expiryDate: expiry },
  );
  if (!issued.ok) {
    const why = (await issued.text()).slice(0, 200);
    throw new Error(`${u.email}: the API key was refused (HTTP ${issued.status}) ${why}`);
  }
  const key = keyOf(await issued.json());
  if (!key) throw new Error(`${u.email}: the answer held no key`);
  saveToken(u.tokenEnv, key);
  console.log(`  ${u.tokenEnv} saved to .env (expires ${expiry})`);
}

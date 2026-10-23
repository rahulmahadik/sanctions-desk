/**
 * Create the three runtime users in Zetaris (one per role) so no agent needs the admin key.
 *
 *   npm run zetaris:agents                 create any missing user (dry run lists them)
 *   npm run zetaris:agents -- --apply
 *   npm run zetaris:sql -- zetaris/sql/09_agents_create.sql --apply --skip-exists    then assign the roles
 *
 *   npm run zetaris:agents -- --apply --passwords    also (re)set every password and write them to
 *                                                    .local/zetaris-agent-passwords.txt (git-ignored, mode 600)
 *
 * A random password is never printed. It is only written to that local file, so that a person can sign in to the
 * Zetaris UI once as each user and create its API token (the REST API does not issue tokens to other users).
 * The admin key is read from the environment and used here only.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectRoot } from "@sanctions-desk/shared";
import { USL_AGENT_USERS } from "@sanctions-desk/zetaris";

const apply = process.argv.includes("--apply");
const passwords = process.argv.includes("--passwords");
const envFile = join(projectRoot(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { zetaris } = loadConfig();
if (!zetaris.apiKey) throw new Error("ZETARIS_API_KEY is not set");

const headers = {
  Authorization: `Bearer ${zetaris.apiKey.reveal()}`,
  "X-Org-ID": String(zetaris.orgId),
  "content-type": "application/json",
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${zetaris.restUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

const listed = (await (await call("GET", "/users")).json()) as Array<{ email: string }>;
const known = new Set(listed.map((u) => u.email.toLowerCase()));
const issued: string[] = [];
for (const u of USL_AGENT_USERS) {
  const exists = known.has(u.email.toLowerCase());
  console.log(`${exists ? "exists " : apply ? "creating" : "would create"} ${u.email} (GENERAL level, role ${u.role})`);
  if (!apply || (exists && !passwords)) continue;
  const password = `${randomBytes(18).toString("base64url")}Aa1!`;
  const body = { email: u.email, name: u.name, level: "GENERAL", password, isLdap: false };
  const res = exists ? await call("PATCH", `/users/${u.email}`, body) : await call("POST", "/users", body);
  console.log(`  ${res.ok ? "ok" : `failed (HTTP ${res.status})`}`);
  if (res.ok && passwords) issued.push(`${u.email}\t${password}`);
}
if (issued.length > 0) {
  const dir = join(projectRoot(), ".local");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "zetaris-agent-passwords.txt"), `${issued.join("\n")}\n`, { mode: 0o600 });
  console.log(`wrote ${issued.length} passwords to .local/zetaris-agent-passwords.txt`);
}

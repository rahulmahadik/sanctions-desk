/**
 * Add a person to the users file, or replace their token.
 *
 *   npm run users:add -- --file ~/.sanctions-desk/users.json --id olga --role approver
 *
 * Roles: analyst, approver, policy_admin, viewer. A new token is generated and printed once; the file keeps only its
 * SHA-256, so a lost token is replaced, not recovered. Keep the file outside the repository and point DESK_USERS_FILE
 * at it.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashToken, loadUsersFile, ROLES, type UsersFile } from "@sanctions-desk/shared";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = arg("--file");
const id = arg("--id");
const role = arg("--role");
if (!file || !id || !role || !(ROLES as readonly string[]).includes(role)) {
  console.error(`usage: npm run users:add -- --file <path> --id <name> --role <${ROLES.join("|")}>`);
  process.exit(1);
}
const path = resolve(file);
if (/\/sanctions-desk(\/|$)/.test(path) && !path.includes(".sanctions-desk"))
  console.error("note: keep the users file outside the repository");
const current: UsersFile = existsSync(path) ? loadUsersFile(path) : { users: [] };
const token = `sd_${randomBytes(24).toString("base64url")}`;
const users = [
  ...current.users.filter((u) => u.id !== id),
  { id, role: role as UsersFile["users"][number]["role"], token_sha256: hashToken(token) },
];
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`${id} (${role}) saved in ${path}`);
console.log(`token (shown once): ${token}`);

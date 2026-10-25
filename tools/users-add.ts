/**
 * Add a person to the users file, rotate their token, or revoke it.
 *
 *   npm run users:add -- --file ~/.sanctions-desk/users.json --id olga --role approver --by admin [--expires 90d]
 *   npm run users:rotate -- --file ~/.sanctions-desk/users.json --id olga --by admin [--expires 90d]
 *   npm run users:revoke -- --file ~/.sanctions-desk/users.json --id olga --by admin
 *
 * Roles: analyst, approver, policy_admin, viewer. A new token (192 random bits) is printed once; the file keeps only
 * its SHA-256, so a lost token is rotated, not recovered. A rotated or revoked token stops working on the next request
 * to a running server. Every change is logged in users-audit.jsonl beside the file (who, when, what; never a token).
 * Keep the file outside the repository and point DESK_USERS_FILE at it.
 */
import { resolve } from "node:path";
import { changeUsers, ROLES, type Role, type UsersChange } from "@sanctions-desk/shared";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const action = (arg("--action") ?? "add") as UsersChange;
const file = arg("--file");
const id = arg("--id");
const role = arg("--role");
const by = arg("--by");
if (
  !["add", "rotate", "revoke"].includes(action) ||
  !file ||
  !id ||
  !by ||
  (action === "add" && (!role || !(ROLES as readonly string[]).includes(role)))
) {
  console.error(
    `usage: npm run users:${action} -- --file <path> --id <name> --by <your name>${action === "add" ? ` --role <${ROLES.join("|")}>` : ""}${action === "revoke" ? "" : " [--expires 90d]"}`,
  );
  process.exit(1);
}
const path = resolve(file);
if (/\/sanctions-desk(\/|$)/.test(path) && !path.includes(".sanctions-desk"))
  console.error("note: keep the users file outside the repository");
try {
  const { token } = changeUsers(path, { action, id, by, role: role as Role | undefined, expires: arg("--expires") });
  console.log(
    `${id}: ${action === "revoke" ? "revoked" : action === "rotate" ? "new token issued; the old one no longer works" : "saved"} in ${path}`,
  );
  if (token) console.log(`token (shown once): ${token}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

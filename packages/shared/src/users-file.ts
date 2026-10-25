import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashToken, loadUsersFile, type Role, TOKEN_FORMAT_NAME, type UsersFile } from "./auth.js";

/**
 * Changes to the users file: add a person, rotate their token, revoke it. Each change writes the file (mode 0600)
 * and appends one line to `users-audit.jsonl` beside it: when, who made the change, what, and for whom. A token is
 * returned once to the caller and never written anywhere; the file keeps only its SHA-256.
 */

export type UsersChange = "add" | "rotate" | "revoke";

/** A new token: sd_ and 24 random bytes in base64url (192 bits). */
export const newToken = (): string => `sd_${randomBytes(24).toString("base64url")}`;

/** "30d", "12h" or an ISO time, to an ISO time; undefined for none. */
export function expiryOf(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const rel = /^(\d+)([dh])$/.exec(value);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`--expires must be like 30d, 12h or an ISO time, not ${value}`);
  return new Date(at).toISOString();
}

function save(
  path: string,
  users: UsersFile,
  entry: { by: string; action: UsersChange; id: string; detail?: string },
  now: Date,
) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  appendFileSync(join(dirname(path), "users-audit.jsonl"), `${JSON.stringify({ ts: now.toISOString(), ...entry })}\n`, {
    mode: 0o600,
  });
}

export function changeUsers(
  path: string,
  change: { action: UsersChange; id: string; by: string; role?: Role; expires?: string },
  now = new Date(),
): { token?: string; users: UsersFile } {
  if (!change.by) throw new Error("--by is required: who is making the change (it goes in the audit log)");
  const current: UsersFile = existsSync(path) ? loadUsersFile(path) : { users: [] };
  const existing = current.users.find((u) => u.id === change.id);
  const others = current.users.filter((u) => u.id !== change.id);
  const expires_at = expiryOf(change.expires, now);
  if (change.action === "revoke") {
    if (!existing) throw new Error(`no user ${change.id} in ${path}`);
    const users = { users: [...others, { ...existing, revoked_at: now.toISOString() }] };
    save(path, users, { by: change.by, action: "revoke", id: change.id }, now);
    return { users };
  }
  if (change.action === "rotate" && !existing) throw new Error(`no user ${change.id} in ${path}`);
  const role = change.role ?? existing?.role;
  if (!role) throw new Error("--role is required for a new user");
  const token = newToken();
  const users = {
    users: [
      ...others,
      {
        id: change.id,
        role,
        token_sha256: hashToken(token),
        token_format: TOKEN_FORMAT_NAME,
        created_at: now.toISOString(),
        ...(expires_at ? { expires_at } : {}),
      },
    ],
  } satisfies UsersFile;
  save(
    path,
    users,
    { by: change.by, action: change.action, id: change.id, detail: expires_at ? `expires ${expires_at}` : undefined },
    now,
  );
  return { token, users };
}

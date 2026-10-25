import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";

/**
 * People who use the desk. A role decides what a person may do; every action is logged under their id.
 *
 *   analyst        reviews alerts and records decisions on recommendations
 *   approver       a sanctions officer: all of the analyst's rights, can give the second approval for a block and
 *                  can override towards a less cautious outcome
 *   policy_admin   proposes and publishes policy changes
 *   viewer         read only
 *
 * Tokens are never stored: the users file holds the SHA-256 of each. The demo users exist only in sample mode.
 *
 * Every token is made by `npm run users:add` (or `users:rotate`): `sd_` and 32 base64url characters, 192 random bits.
 * A presented token in any other form is refused before it is looked up. A token can carry an expiry, and can be
 * revoked; both take effect on the next request, because the users file is read again whenever it changes.
 */

export const ROLES = ["analyst", "approver", "policy_admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string;
  role: Role;
  /** True for the built-in demo users, which never work in live mode. */
  demo: boolean;
}

export const DEMO_USERS: readonly Actor[] = [
  { id: "analyst_demo", role: "analyst", demo: true },
  { id: "approver_demo", role: "approver", demo: true },
  // A second approver, so the four-eyes step (a block, or an override to a close) can be finished in sample mode.
  { id: "approver2_demo", role: "approver", demo: true },
  { id: "admin_demo", role: "policy_admin", demo: true },
];

export const ANONYMOUS: Actor = { id: "anonymous", role: "viewer", demo: false };

const UserId = z.string().regex(/^[A-Za-z0-9._-]{2,64}$/);

/** The one token form the desk issues and accepts: sd_ and 24 random bytes in base64url (192 bits). */
export const TOKEN_FORMAT_NAME = "sd_192";
export const TOKEN_PATTERN = /^sd_[A-Za-z0-9_-]{32}$/;

export const UsersFileSchema = z.strictObject({
  users: z
    .array(
      z.strictObject({
        id: UserId,
        role: z.enum(ROLES),
        token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** Set by users:add and users:rotate: the token is 192 random bits in the sd_ form. */
        token_format: z.literal(TOKEN_FORMAT_NAME).optional(),
        /** After this time the token is refused (401). */
        expires_at: z.iso.datetime().optional(),
        /** Set by users:revoke: the token is refused from then on. */
        revoked_at: z.iso.datetime().optional(),
        created_at: z.iso.datetime().optional(),
      }),
    )
    .refine((u) => new Set(u.map((x) => x.id)).size === u.length, "user ids must be unique"),
});
export type UsersFile = z.infer<typeof UsersFileSchema>;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function loadUsersFile(path: string): UsersFile {
  if (!existsSync(path)) throw new Error(`the users file ${path} does not exist`);
  return UsersFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Users whose token was not made by users:add or users:rotate (so its strength cannot be known from its hash), and
 * that are not revoked. The server refuses to start with sign-in on while there are any.
 */
export function weakTokenUsers(users: UsersFile): string[] {
  return users.users.filter((u) => u.token_format !== TOKEN_FORMAT_NAME && !u.revoked_at).map((u) => u.id);
}

export function assertStrongTokens(users: UsersFile): void {
  const weak = weakTokenUsers(users);
  if (weak.length > 0)
    throw new Error(
      `the users file has tokens that were not made by users:add (${weak.join(", ")}); issue new ones with ` +
        "`npm run users:rotate -- --file <users file> --id <name> --by <your name>` and start again",
    );
}

/**
 * The users file as it is now: read again when its modification time changes, so a revoke or rotate takes effect on
 * the next request. A file that can no longer be read or parsed gives no users at all (every token is refused).
 */
export function usersFileSource(path: string): () => UsersFile | undefined {
  let mtime = -1;
  let current: UsersFile | undefined;
  return () => {
    try {
      const m = statSync(path).mtimeMs;
      if (m !== mtime) {
        current = loadUsersFile(path);
        mtime = m;
      }
    } catch {
      current = undefined;
      mtime = -1;
    }
    return current;
  };
}

export type AuthMode = "on" | "demo" | "off";

/** `auto` is `on` live and `demo` in sample mode. `off` is refused in live mode. */
export function resolveAuthMode(setting: "auto" | "on" | "demo" | "off", sampleMode: boolean): AuthMode {
  if (setting === "auto") return sampleMode ? "demo" : "on";
  if (setting === "demo" && !sampleMode) throw new Error("auth mode demo is only available in sample mode");
  if (setting === "off" && !sampleMode) throw new Error("auth mode off is only available in sample mode");
  return setting;
}

export interface Authenticator {
  readonly mode: AuthMode;
  /** The person behind a request, or undefined when they gave no valid credentials. */
  actorFor(headers: Record<string, string | string[] | undefined>): Actor | undefined;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The user whose token this is. A token not in the issued form is refused first; a revoked or expired one is refused
 * after the comparison. Every user is compared, so the time taken does not show which one matched.
 */
function userForToken(users: UsersFile | undefined, bearer: string | undefined, now: Date): Actor | undefined {
  if (bearer === undefined || !users || !TOKEN_PATTERN.test(bearer)) return undefined;
  const digest = hashToken(bearer);
  let found: UsersFile["users"][number] | undefined;
  for (const u of users.users) if (sameHash(u.token_sha256, digest)) found = u;
  if (!found || found.revoked_at) return undefined;
  if (found.expires_at && Date.parse(found.expires_at) <= now.getTime()) return undefined;
  return { id: found.id, role: found.role, demo: false };
}

export function createAuthenticator(options: {
  mode: AuthMode;
  sampleMode: boolean;
  /** The users, fixed, or a source read on each request (usersFileSource). */
  users?: UsersFile | (() => UsersFile | undefined);
  now?: () => Date;
}): Authenticator {
  const { mode, sampleMode, users } = options;
  const usersNow = typeof users === "function" ? users : () => users;
  const now = options.now ?? (() => new Date());
  return {
    mode,
    actorFor(headers) {
      const person = userForToken(usersNow(), /^Bearer\s+(\S+)$/i.exec(first(headers.authorization) ?? "")?.[1], now());
      if (person) return person;
      // Demo users work only in sample mode, and only when auth is not fully on.
      const demo =
        sampleMode && mode !== "on" ? DEMO_USERS.find((d) => d.id === first(headers["x-demo-user"])) : undefined;
      if (demo) return demo;
      return mode === "on" ? undefined : ANONYMOUS;
    },
  };
}

/** What each role may do. Reading is open to every signed-in role. */
export const PERMISSIONS = {
  run: ["analyst", "approver", "policy_admin"],
  decide: ["analyst", "approver"],
  approveBlock: ["approver"],
  overrideTowardsLessCaution: ["approver"],
  proposePolicy: ["approver", "policy_admin"],
  publishPolicy: ["policy_admin"],
  stopAutonomy: ["approver", "policy_admin"],
  restoreAutonomy: ["policy_admin"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (actor: Actor, permission: Permission): boolean =>
  (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);

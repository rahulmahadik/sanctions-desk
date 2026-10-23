import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  { id: "admin_demo", role: "policy_admin", demo: true },
];

export const ANONYMOUS: Actor = { id: "anonymous", role: "viewer", demo: false };

const UserId = z.string().regex(/^[A-Za-z0-9._-]{2,64}$/);

export const UsersFileSchema = z.strictObject({
  users: z
    .array(
      z.strictObject({
        id: UserId,
        role: z.enum(ROLES),
        token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
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

/** The user whose token this is. Every user is compared, so the time taken does not show which one matched. */
function userForToken(users: UsersFile | undefined, bearer: string | undefined): Actor | undefined {
  if (bearer === undefined || !users) return undefined;
  const digest = hashToken(bearer);
  let found: Actor | undefined;
  for (const u of users.users) if (sameHash(u.token_sha256, digest)) found = { id: u.id, role: u.role, demo: false };
  return found;
}

export function createAuthenticator(options: {
  mode: AuthMode;
  sampleMode: boolean;
  users?: UsersFile;
}): Authenticator {
  const { mode, sampleMode, users } = options;
  return {
    mode,
    actorFor(headers) {
      const person = userForToken(users, /^Bearer\s+(\S+)$/i.exec(first(headers.authorization) ?? "")?.[1]);
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

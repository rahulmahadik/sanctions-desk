import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS,
  assertStrongTokens,
  can,
  createAuthenticator,
  DEMO_USERS,
  hashToken,
  resolveAuthMode,
  type UsersFile,
  usersFileSource,
} from "../src/index.js";

/** A token in the issued form (sd_ and 32 base64url characters), made from a seed so the test is repeatable. */
const tok = (seed: string): string => `sd_${createHash("sha256").update(seed).digest("base64url").slice(0, 32)}`;

const users: UsersFile = {
  users: [
    { id: "ann", role: "analyst", token_format: "sd_192" as const, token_sha256: hashToken(tok("t-ann")) },
    { id: "olga", role: "approver", token_format: "sd_192" as const, token_sha256: hashToken(tok("t-olga")) },
  ],
};
const headers = (h: Record<string, string | undefined>) => h;

describe("resolving the auth mode", () => {
  it("is on live and demo in sample mode when set to auto", () => {
    expect(resolveAuthMode("auto", false)).toBe("on");
    expect(resolveAuthMode("auto", true)).toBe("demo");
  });
  it("refuses the demo and off modes outside sample mode", () => {
    expect(() => resolveAuthMode("demo", false)).toThrow(/only available in sample mode/);
    expect(() => resolveAuthMode("off", false)).toThrow(/only available in sample mode/);
    expect(resolveAuthMode("on", false)).toBe("on");
  });
});

describe("recognising a person", () => {
  const live = createAuthenticator({ mode: "on", sampleMode: false, users });

  it("finds a user by token, comparing hashes", () => {
    expect(live.actorFor(headers({ authorization: `Bearer ${tok("t-ann")}` }))).toEqual({
      id: "ann",
      role: "analyst",
      demo: false,
    });
    expect(live.actorFor(headers({ authorization: `bearer ${tok("t-olga")}` }))?.role).toBe("approver");
  });

  it("returns nobody for a missing, wrong or malformed token", () => {
    for (const h of [
      {},
      { authorization: "Bearer nope" },
      { authorization: "t-ann" },
      { authorization: "Bearer" },
      { authorization: "Basic t-ann" },
    ])
      expect(live.actorFor(headers(h))).toBeUndefined();
  });

  it("never lets a demo user in live mode, whatever header is sent", () => {
    for (const d of DEMO_USERS) expect(live.actorFor(headers({ "x-demo-user": d.id }))).toBeUndefined();
    const liveDemoNamed = createAuthenticator({
      mode: "on",
      sampleMode: false,
      users: {
        users: [
          { id: "analyst_demo", role: "viewer", token_format: "sd_192" as const, token_sha256: hashToken(tok("x")) },
        ],
      },
    });
    expect(liveDemoNamed.actorFor(headers({ "x-demo-user": "analyst_demo" }))).toBeUndefined();
  });

  it("offers the demo users in sample mode, and a read-only visitor otherwise", () => {
    const demo = createAuthenticator({ mode: "demo", sampleMode: true });
    expect(demo.actorFor(headers({ "x-demo-user": "approver_demo" }))).toMatchObject({
      id: "approver_demo",
      demo: true,
    });
    expect(demo.actorFor(headers({}))).toEqual(ANONYMOUS);
    expect(demo.actorFor(headers({ "x-demo-user": "root" }))).toEqual(ANONYMOUS);
  });

  it("does not accept demo users when auth is fully on, even in sample mode", () => {
    const strict = createAuthenticator({ mode: "on", sampleMode: true, users });
    expect(strict.actorFor(headers({ "x-demo-user": "admin_demo" }))).toBeUndefined();
  });
});

describe("what each role may do", () => {
  const actor = (role: "analyst" | "approver" | "policy_admin" | "viewer") => ({ id: role, role, demo: false });
  it("keeps a viewer read-only", () => {
    for (const p of [
      "run",
      "decide",
      "approveBlock",
      "overrideTowardsLessCaution",
      "proposePolicy",
      "publishPolicy",
    ] as const)
      expect(can(actor("viewer"), p)).toBe(false);
  });
  it("gives the second approval of a block, and the less cautious override, only to an approver", () => {
    expect(can(actor("approver"), "approveBlock")).toBe(true);
    expect(can(actor("analyst"), "approveBlock")).toBe(false);
    expect(can(actor("policy_admin"), "approveBlock")).toBe(false);
    expect(can(actor("analyst"), "overrideTowardsLessCaution")).toBe(false);
  });
  it("lets only a policy admin publish, and an approver or admin propose", () => {
    expect(can(actor("policy_admin"), "publishPolicy")).toBe(true);
    expect(can(actor("approver"), "publishPolicy")).toBe(false);
    expect(can(actor("approver"), "proposePolicy")).toBe(true);
    expect(can(actor("analyst"), "proposePolicy")).toBe(false);
  });
});

describe("token strength, expiry and revocation", () => {
  const strong = tok("strong");
  const entry = (over: Partial<UsersFile["users"][number]> = {}) => ({
    id: "ann",
    role: "analyst" as const,
    token_format: "sd_192" as const,
    token_sha256: hashToken(strong),
    ...over,
  });
  const auth = (u: UsersFile["users"][number], now = new Date("2026-10-25T12:00:00Z")) =>
    createAuthenticator({ mode: "on", sampleMode: false, users: { users: [u] }, now: () => now });

  it("refuses a token that is not in the issued form, even if its hash is in the file", () => {
    for (const weak of ["short", "sd_tooShort", "a".repeat(40), `${strong}x`]) {
      const a = auth(entry({ token_sha256: hashToken(weak) }));
      expect(a.actorFor(headers({ authorization: `Bearer ${weak}` }))).toBeUndefined();
    }
  });

  it("refuses an expired token and accepts it before its expiry", () => {
    const u = entry({ expires_at: "2026-10-25T13:00:00Z" });
    expect(auth(u).actorFor(headers({ authorization: `Bearer ${strong}` }))?.id).toBe("ann");
    expect(
      auth(u, new Date("2026-10-25T13:00:01Z")).actorFor(headers({ authorization: `Bearer ${strong}` })),
    ).toBeUndefined();
  });

  it("refuses a revoked token", () => {
    const a = auth(entry({ revoked_at: "2026-10-25T11:00:00Z" }));
    expect(a.actorFor(headers({ authorization: `Bearer ${strong}` }))).toBeUndefined();
  });

  it("refuses to start with a token that users:add did not make, and names the user", () => {
    expect(() => assertStrongTokens({ users: [entry({ token_format: undefined })] })).toThrow(/ann.*users:rotate/);
    expect(() =>
      assertStrongTokens({ users: [entry({ token_format: undefined, revoked_at: "2026-10-25T11:00:00Z" })] }),
    ).not.toThrow();
    expect(() => assertStrongTokens({ users: [entry()] })).not.toThrow();
  });

  it("reads the users file again when it changes, so a revoke takes effect on the next request", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-users-"));
    const file = join(dir, "users.json");
    writeFileSync(file, JSON.stringify({ users: [entry()] }));
    const a = createAuthenticator({ mode: "on", sampleMode: false, users: usersFileSource(file) });
    expect(a.actorFor(headers({ authorization: `Bearer ${strong}` }))?.id).toBe("ann");
    writeFileSync(file, JSON.stringify({ users: [entry({ revoked_at: "2026-10-25T11:00:00Z" })] }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(a.actorFor(headers({ authorization: `Bearer ${strong}` }))).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

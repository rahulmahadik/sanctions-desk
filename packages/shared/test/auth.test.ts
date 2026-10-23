import { describe, expect, it } from "vitest";
import {
  ANONYMOUS,
  can,
  createAuthenticator,
  DEMO_USERS,
  hashToken,
  resolveAuthMode,
  type UsersFile,
} from "../src/index.js";

const users: UsersFile = {
  users: [
    { id: "ann", role: "analyst", token_sha256: hashToken("t-ann") },
    { id: "olga", role: "approver", token_sha256: hashToken("t-olga") },
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
    expect(live.actorFor(headers({ authorization: "Bearer t-ann" }))).toEqual({
      id: "ann",
      role: "analyst",
      demo: false,
    });
    expect(live.actorFor(headers({ authorization: "bearer t-olga" }))?.role).toBe("approver");
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
      users: { users: [{ id: "analyst_demo", role: "viewer", token_sha256: hashToken("x") }] },
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

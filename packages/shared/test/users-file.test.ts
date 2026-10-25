import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changeUsers, createAuthenticator, expiryOf, loadUsersFile, usersFileSource } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "desk-users-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("the users file: add, rotate, revoke", () => {
  it("issues a 192-bit token once, rotates it so the old one stops working, and revokes it", () => {
    const file = join(dir, "users.json");
    const auth = createAuthenticator({ mode: "on", sampleMode: false, users: usersFileSource(file) });
    const added = changeUsers(file, { action: "add", id: "olga", role: "approver", by: "rahul" });
    expect(added.token).toMatch(/^sd_[A-Za-z0-9_-]{32}$/);
    expect(auth.actorFor(bearer(added.token as string))?.id).toBe("olga");

    const rotated = changeUsers(file, { action: "rotate", id: "olga", by: "rahul" }, new Date(Date.now() + 1000));
    expect(rotated.token).not.toBe(added.token);
    expect(auth.actorFor(bearer(added.token as string))).toBeUndefined();
    expect(auth.actorFor(bearer(rotated.token as string))?.role).toBe("approver");

    changeUsers(file, { action: "revoke", id: "olga", by: "rahul" }, new Date(Date.now() + 2000));
    expect(auth.actorFor(bearer(rotated.token as string))).toBeUndefined();

    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(added.token as string);
    const audit = readFileSync(join(dir, "users-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(audit.map((a) => [a.action, a.id, a.by])).toEqual([
      ["add", "olga", "rahul"],
      ["rotate", "olga", "rahul"],
      ["revoke", "olga", "rahul"],
    ]);
    expect(JSON.stringify(audit)).not.toContain("sd_");
  });

  it("records an expiry and refuses the token after it", () => {
    const file = join(dir, "expiring.json");
    const now = new Date("2026-10-25T12:00:00Z");
    const { token } = changeUsers(file, { action: "add", id: "ann", role: "analyst", by: "rahul", expires: "1d" }, now);
    expect(loadUsersFile(file).users[0]?.expires_at).toBe("2026-10-26T12:00:00.000Z");
    const at = (iso: string) =>
      createAuthenticator({ mode: "on", sampleMode: false, users: usersFileSource(file), now: () => new Date(iso) });
    expect(at("2026-10-26T11:59:59Z").actorFor(bearer(token as string))?.id).toBe("ann");
    expect(at("2026-10-26T12:00:01Z").actorFor(bearer(token as string))).toBeUndefined();
    expect(() => expiryOf("soon", now)).toThrow(/--expires/);
  });

  it("refuses a bad id or role before writing, so the file stays readable", () => {
    const file = join(dir, "guarded.json");
    changeUsers(file, { action: "add", id: "ann", role: "analyst", by: "rahul" });
    const before = readFileSync(file, "utf8");
    expect(() => changeUsers(file, { action: "add", id: "two words", role: "analyst", by: "rahul" })).toThrow(
      /not saved/,
    );
    expect(() => changeUsers(file, { action: "add", id: "bob", role: "/some/path" as never, by: "rahul" })).toThrow(
      /not saved/,
    );
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(loadUsersFile(file).users.map((u) => u.id)).toEqual(["ann"]);
  });

  it("needs to know who makes the change, and the user to exist for rotate and revoke", () => {
    const file = join(dir, "strict.json");
    expect(() => changeUsers(file, { action: "add", id: "x1", role: "viewer", by: "" })).toThrow(/--by/);
    expect(() => changeUsers(file, { action: "rotate", id: "nobody", by: "rahul" })).toThrow(/no user/);
  });
});

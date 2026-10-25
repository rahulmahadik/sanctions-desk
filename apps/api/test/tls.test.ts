import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

// A throwaway self-signed certificate made for this test only; no key is kept in the repository.
const dir = mkdtempSync(join(tmpdir(), "desk-tls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cert = join(dir, "cert.pem");
const key = join(dir, "key.pem");
const made =
  spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  ).status === 0;

const get = (url: string, secure: boolean) =>
  new Promise<number | string>((done) => {
    const req = (secure ? httpsRequest : httpRequest)(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", (e) => done(e.message));
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.end();
  });

describe.skipIf(!made)("HTTPS", () => {
  it("serves HTTPS only when a certificate and key are configured", async () => {
    const { app } = await makeApp({ overrides: { server: { tls: { certFile: cert, keyFile: key } } } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    expect(await get(`https://127.0.0.1:${port}/health`, true)).toBe(200);
    expect(await get(`http://127.0.0.1:${port}/health`, false)).not.toBe(200);
    await app.close();
  });
});

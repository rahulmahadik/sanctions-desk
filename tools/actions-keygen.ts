/**
 * Make an Ed25519 key pair for signing the records written after an approval.
 *
 *   npm run actions:keygen                      writes ~/.sanctions-desk/signing.pem
 *   npm run actions:keygen -- --out <path>
 *
 * The private key stays where it is written (outside the repository, mode 600). Put its path in
 * DESK_SIGNING_KEY_FILE and the printed public key in DESK_SIGNING_PUBLIC_KEY. Existing keys are never overwritten.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const i = process.argv.indexOf("--out");
const out = resolve(i >= 0 ? (process.argv[i + 1] as string) : join(homedir(), ".sanctions-desk", "signing.pem"));
if (existsSync(out)) {
  console.error(`${out} already exists; not overwriting it`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
chmodSync(out, 0o600);
const der = publicKey.export({ format: "der", type: "spki" });
console.log(`private key: ${out}`);
console.log(`DESK_SIGNING_KEY_FILE=${out}`);
console.log(`DESK_SIGNING_PUBLIC_KEY=${der.subarray(der.length - 32).toString("base64")}`);

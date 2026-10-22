/**
 * Prints the Ed25519 public key (base64) that signs this Nightshift runtime's receipts, so you can
 * pin it yourself:  METERLESS_RECEIPT_PUBLIC_KEY=<printed value>
 *
 * It makes one live model call and prints ONLY the public key on stdout. Nothing secret is printed:
 * the runtime token is never shown, and the receipt body is not echoed.
 *
 *   npm run receipt:pubkey
 */
import { existsSync } from "node:fs";
import {
  AppError,
  createNightshiftGenerator,
  loadConfig,
  resolveProjectPath,
  toStructuredError,
} from "@sanctions-desk/shared";

async function main(): Promise<number> {
  const envFile = resolveProjectPath(".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();
  const { nightshift } = config;

  const generate = createNightshiftGenerator({
    baseUrl: nightshift.baseUrl,
    token: nightshift.runtimeToken,
    appId: nightshift.appId,
    scope: nightshift.scope,
    models: nightshift.models,
    timeoutMs: nightshift.requestTimeoutMs,
    receiptPublicKeys: nightshift.receiptPublicKeys,
  });

  try {
    // A fresh prompt, so the answer is generated and signed now.
    const result = await generate({ prompt: `Reply with the single word: ready ${Date.now()}`, maxTokens: 1024 });
    if (!result.receipt) {
      process.stderr.write("The runtime answered without a signed receipt.\n");
      return 1;
    }
    process.stdout.write(`${result.receipt.pubkey_b64}\n`);
    process.stderr.write(
      `receipt ${result.receipt.receipt_id}: signature ${result.receipt.verification}` +
        (result.receipt.verification === "valid_unpinned"
          ? " (add the key above as METERLESS_RECEIPT_PUBLIC_KEY to pin it)\n"
          : "\n"),
    );
    return result.receipt.verification === "invalid" || result.receipt.verification === "malformed" ? 1 : 0;
  } catch (err) {
    const e = err instanceof AppError ? err.toJSON() : toStructuredError(err);
    process.stderr.write(`Could not get a receipt: ${e.type}: ${e.message}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));

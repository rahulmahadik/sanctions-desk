import { readFileSync } from "node:fs";
import { buildPaymentsApp } from "./app.js";

const file = process.env.PAYMENTS_FILE ?? "data/synthetic/payment.json";
const port = Number(process.env.PORT ?? 8100);
const host = process.env.HOST ?? "0.0.0.0";

const apiKey = process.env.PAYMENTS_API_KEY;
if (!apiKey) {
  process.stderr.write("PAYMENTS_API_KEY must be set: the payments service does not run without a key\n");
  process.exit(1);
}

const app = buildPaymentsApp({ payments: JSON.parse(readFileSync(file, "utf8")), apiKey });
await app.listen({ host, port });
process.stdout.write(`payments-api listening on ${host}:${port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}

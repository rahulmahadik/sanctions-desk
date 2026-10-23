// Connectors: what Zetaris does for us when it onboards a source.
import { readFileSync } from "node:fs";
import pg from "pg";

export async function readBank(env) {
  const client = new pg.Client({
    host: env.BANKDB_HOST,
    port: Number(env.BANKDB_PORT ?? 5432),
    user: "zetaris_reader",
    password: env.BANKDB_READER_PASSWORD,
    database: "bank",
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    const tables = {};
    for (const name of ["customer", "alert", "beneficial_owner"]) {
      tables[name] = (await client.query(`SELECT * FROM ${name}`)).rows;
    }
    return tables;
  } finally {
    await client.end();
  }
}

export async function readPayments(env) {
  const res = await fetch(`${env.PAYMENTS_URL}/payments`, {
    headers: { "x-api-key": env.PAYMENTS_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`payments service answered ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : body.payments;
}

export function readList(dir, name) {
  return JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));
}

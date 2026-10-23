// Connectors: connect, authenticate, read, parse. Each read has a timeout and is retried.
import { readFileSync } from "node:fs";
import pg from "pg";
import { withRetry } from "./retry.mjs";

export function readBank(env, names) {
  return withRetry("bank database", async () => {
    const client = new pg.Client({
      host: env.BANKDB_HOST,
      port: Number(env.BANKDB_PORT ?? 5432),
      user: "zetaris_reader",
      password: env.BANKDB_READER_PASSWORD,
      database: "bank",
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
    });
    await client.connect();
    try {
      const tables = {};
      for (const name of names) tables[name] = (await client.query(`SELECT * FROM ${name}`)).rows;
      return tables;
    } finally {
      await client.end();
    }
  });
}

export function readPayments(env) {
  return withRetry("payments service", async () => {
    const res = await fetch(`${env.PAYMENTS_URL}/payments`, {
      headers: { "x-api-key": env.PAYMENTS_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`payments service answered ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : body.payments;
  });
}

export function readList(dir, name) {
  return JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));
}

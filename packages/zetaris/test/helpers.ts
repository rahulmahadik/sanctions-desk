import { type Config, type FetchLike, loadConfig } from "@sanctions-desk/shared";

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    env: { ZETARIS_REST_URL: "http://zetaris.test/api/v1.0", ...env },
  });
}

export interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { queryId: string; sql: string; limit: number };
}

/** A fake Zetaris REST endpoint. `answer` receives the SQL and returns the HTTP status and body. */
export function fakeZetaris(answer: (sql: string) => { status?: number; body: unknown }): {
  fetchImpl: FetchLike;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : { queryId: "", sql: "", limit: 0 };
    sent.push({ url, headers: init?.headers as Record<string, string>, body });
    const out = answer(body.sql);
    const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
    return new Response(text, { status: out.status ?? 200 });
  };
  return { fetchImpl, sent };
}

export const rowsOf = (headers: string[], data: Array<Array<string | null>>) => ({
  headers,
  data,
  total: data.length,
  timeUsed: 5,
});

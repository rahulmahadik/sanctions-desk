import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type FetchLike, sha256Hex } from "@sanctions-desk/shared";
import { z } from "zod";

/**
 * Recorded Zetaris answers. The same client, with the same SQL guard, runs on top of a transport that serves
 * saved responses, so a review can run with no Zetaris at all. Entries come only from real queries.
 */

export const QueryCacheSchema = z.object({
  version: z.literal(1),
  note: z.string(),
  recorded_at: z.string().optional(),
  entries: z.record(z.string(), z.object({ sql: z.string(), status: z.number().int(), body: z.string() })),
});
export type QueryCache = z.infer<typeof QueryCacheSchema>;

export const CACHE_NOTE =
  "Responses saved from real Zetaris queries over the synthetic sample. Used by sample mode; never edited by hand.";

export function emptyCache(): QueryCache {
  return { version: 1, note: CACHE_NOTE, entries: {} };
}

export function loadQueryCache(path: string): QueryCache {
  return QueryCacheSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function saveQueryCache(path: string, cache: QueryCache): void {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ ...cache, entries: sorted })}\n`);
}

const sqlOf = (init: RequestInit | undefined): string =>
  String((JSON.parse(String(init?.body)) as { sql: string }).sql);

/** Serve saved answers. A statement that was never recorded gets a clear "not in the sample cache" error. */
export function replayFetch(cache: QueryCache): FetchLike {
  return async (_url, init) => {
    const hit = cache.entries[sha256Hex(sqlOf(init))];
    if (!hit) {
      return new Response(JSON.stringify({ msg: "this query is not in the sample cache" }), { status: 404 });
    }
    return new Response(hit.body, { status: hit.status });
  };
}

/** Wrap a real transport and keep every successful answer in `cache`. */
export function recordingFetch(inner: FetchLike, cache: QueryCache, now: () => Date = () => new Date()): FetchLike {
  return async (url, init) => {
    const response = await inner(url, init);
    if (response.status === 200) {
      const sql = sqlOf(init);
      cache.entries[sha256Hex(sql)] = { sql, status: 200, body: await response.clone().text() };
      cache.recorded_at = now().toISOString();
    }
    return response;
  };
}

export const cacheExists = (path: string): boolean => existsSync(path);

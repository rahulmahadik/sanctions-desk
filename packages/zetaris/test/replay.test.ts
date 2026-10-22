import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createZetarisClient } from "../src/client.js";
import { cacheExists, emptyCache, loadQueryCache, recordingFetch, replayFetch, saveQueryCache } from "../src/replay.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const T = "lightning.metastore.sanctions.screening_usl.customer";

describe("recording and replaying", () => {
  it("replays recorded answers through the same client and guard, offline", async () => {
    const live = fakeZetaris((sql) => ({ body: rowsOf(["n"], [[String(sql.length)]]) }));
    const cache = emptyCache();
    const recorder = createZetarisClient({
      config: testConfig({ ZETARIS_TOKEN_EVIDENCE: "e-token" }),
      fetchImpl: recordingFetch(live.fetchImpl, cache, () => new Date("2026-10-22T00:00:00Z")),
    });
    recorder.setAllowedTables([T]);
    const recorded = await recorder.query("evidence", `SELECT n FROM ${T}`);
    expect(Object.keys(cache.entries)).toHaveLength(1);
    expect(cache.recorded_at).toBe("2026-10-22T00:00:00.000Z");

    const file = join(mkdtempSync(join(tmpdir(), "zcache-")), "cache.json");
    saveQueryCache(file, cache);
    expect(cacheExists(file)).toBe(true);

    const replay = createZetarisClient({
      config: testConfig(),
      fetchImpl: replayFetch(loadQueryCache(file)),
      offline: true,
    });
    replay.setAllowedTables([T]);
    const replayed = await replay.query("evidence", `SELECT n FROM ${T}`);
    expect(replayed.objects).toEqual(recorded.objects);
    expect(replay.tokenSource("evidence")).toBe("role");
    await expect(replay.query("evidence", "DROP TABLE x")).rejects.toMatchObject({ type: "guard_blocked" });
  });

  it("answers a statement that was never recorded with a clear error", async () => {
    const replay = createZetarisClient({ config: testConfig(), fetchImpl: replayFetch(emptyCache()), offline: true });
    replay.setAllowedTables([T]);
    await expect(replay.query("evidence", `SELECT x FROM ${T}`)).rejects.toMatchObject({
      type: "query_failed",
      message: expect.stringContaining("not in the sample cache"),
    });
  });

  it("does not record failures", async () => {
    const live = fakeZetaris(() => ({ status: 400, body: { msg: "bad" } }));
    const cache = emptyCache();
    const client = createZetarisClient({
      config: testConfig({ ZETARIS_TOKEN_EVIDENCE: "e" }),
      fetchImpl: recordingFetch(live.fetchImpl, cache),
    });
    client.setAllowedTables([T]);
    await expect(client.query("evidence", `SELECT x FROM ${T}`)).rejects.toBeDefined();
    expect(Object.keys(cache.entries)).toHaveLength(0);
  });

  it("without a token, a non-offline client still refuses", async () => {
    const client = createZetarisClient({ config: testConfig(), fetchImpl: replayFetch(emptyCache()) });
    client.setAllowedTables([T]);
    await expect(client.query("evidence", `SELECT x FROM ${T}`)).rejects.toMatchObject({ type: "config_missing" });
  });
});

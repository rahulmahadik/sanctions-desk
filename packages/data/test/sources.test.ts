import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DataSource,
  type DataSourcesConfig,
  DataSourcesConfigSchema,
  fetchSource,
  findSource,
  latestRaw,
  loadDataSources,
} from "../src/index.js";
import { fixturePath, tempDir } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

async function serve(handler: (path: string) => { status?: number; body: string; hang?: boolean }): Promise<string> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? "/");
    if (out.hang) return;
    res.writeHead(out.status ?? 200, { "content-type": "application/xml" });
    res.end(out.body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function configFor(base: string, rawDir: string, timeout = 5000): { config: DataSourcesConfig; source: DataSource } {
  const source: DataSource = {
    id: "ofac-sdn",
    list: "OFAC",
    sanctionsList: "SDN List",
    format: "ofac-advanced",
    url: `${base}/SDN_ADVANCED.XML`,
    file: "SDN_ADVANCED.XML",
  };
  return {
    source,
    config: {
      userAgent: "test-agent",
      requestTimeoutMs: timeout,
      rawDir,
      normalisedDir: join(rawDir, "n"),
      sources: [source],
    },
  };
}

const xmlBody = readFileSync(fixturePath("ofac-mini.xml"), "utf8");
const at = (iso: string) => () => new Date(iso);

describe("committed data source configuration", () => {
  it("loads and validates, with the three public sources", () => {
    const config = loadDataSources();
    expect(config.sources.map((s) => s.id)).toEqual(["ofac-sdn", "ofac-consolidated", "un-consolidated"]);
    expect(config.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
    expect(findSource(config, "un-consolidated").list).toBe("UN");
    expect(() => findSource(config, "nope")).toThrow(/unknown data source/);
  });

  it("rejects duplicate ids, unsafe file names and bad urls", () => {
    const good = loadDataSources();
    const first = good.sources[0] as DataSource;
    expect(DataSourcesConfigSchema.safeParse({ ...good, sources: [first, first] }).success).toBe(false);
    expect(DataSourcesConfigSchema.safeParse({ ...good, sources: [{ ...first, file: "../x" }] }).success).toBe(false);
    expect(DataSourcesConfigSchema.safeParse({ ...good, sources: [{ ...first, url: "not a url" }] }).success).toBe(
      false,
    );
    expect(() => loadDataSources("config/missing.json")).toThrow(/cannot read data sources/);
  });
});

describe("fetchSource", () => {
  it("downloads into raw/<source>/<date>/, records the hash and size, and writes a fetch record", async () => {
    const base = await serve(() => ({ body: xmlBody }));
    const rawDir = tempDir();
    const { config, source } = configFor(base, rawDir);
    const result = await fetchSource(config, source, { now: at("2026-10-23T10:00:00.000Z") });

    expect(result.reused).toBe(false);
    expect(result.path).toBe(join(rawDir, "ofac-sdn", "2026-10-23", "SDN_ADVANCED.XML"));
    expect(readFileSync(result.path, "utf8")).toBe(xmlBody);
    expect(result.bytes).toBe(Buffer.byteLength(xmlBody));
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fetched_at).toBe("2026-10-23T10:00:00.000Z");
    expect(existsSync(`${result.path}.partial`)).toBe(false);
    expect(JSON.parse(readFileSync(`${result.path}.fetch.json`, "utf8"))).toMatchObject({
      source_id: "ofac-sdn",
      sha256: result.sha256,
    });
  });

  it("reuses the same day's download unless forced", async () => {
    let hits = 0;
    const base = await serve(() => {
      hits += 1;
      return { body: xmlBody };
    });
    const { config, source } = configFor(base, tempDir());
    const now = at("2026-10-23T10:00:00.000Z");
    const one = await fetchSource(config, source, { now });
    const two = await fetchSource(config, source, { now });
    expect(two.reused).toBe(true);
    expect(two.sha256).toBe(one.sha256);
    expect(hits).toBe(1);
    const three = await fetchSource(config, source, { now, force: true });
    expect(three.reused).toBe(false);
    expect(hits).toBe(2);
  });

  it("rejects an error page that is not XML, leaving no file behind", async () => {
    const base = await serve(() => ({ body: "Service unavailable" }));
    const rawDir = tempDir();
    const { config, source } = configFor(base, rawDir);
    await expect(fetchSource(config, source, { now: at("2026-10-23T10:00:00.000Z") })).rejects.toMatchObject({
      type: "bad_response",
    });
    expect(existsSync(join(rawDir, "ofac-sdn", "2026-10-23", "SDN_ADVANCED.XML"))).toBe(false);
    expect(existsSync(join(rawDir, "ofac-sdn", "2026-10-23", "SDN_ADVANCED.XML.partial"))).toBe(false);
  });

  it("reports HTTP errors, unreachable hosts and timeouts as recoverable", async () => {
    const down = await serve(() => ({ status: 503, body: "no" }));
    const a = configFor(down, tempDir());
    await expect(fetchSource(a.config, a.source)).rejects.toMatchObject({ type: "http_error", recoverable: true });

    const b = configFor("http://127.0.0.1:1", tempDir());
    await expect(fetchSource(b.config, b.source)).rejects.toMatchObject({ type: "network", recoverable: true });

    const slow = await serve(() => ({ body: "", hang: true }));
    const c = configFor(slow, tempDir(), 150);
    await expect(fetchSource(c.config, c.source)).rejects.toMatchObject({ type: "network" });
  });

  it("sends the configured user agent", async () => {
    let seen = "";
    const server = createServer((req, res) => {
      seen = String(req.headers["user-agent"]);
      res.end(xmlBody);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const { config, source } = configFor(`http://127.0.0.1:${address.port}`, tempDir());
    await fetchSource(config, source);
    expect(seen).toBe("test-agent");
  });
});

describe("latestRaw", () => {
  it("finds the newest complete download of a source", async () => {
    const base = await serve(() => ({ body: xmlBody }));
    const { config, source } = configFor(base, tempDir());
    expect(latestRaw(config, source)).toBeUndefined();
    await fetchSource(config, source, { now: at("2026-10-21T10:00:00.000Z") });
    await fetchSource(config, source, { now: at("2026-10-23T10:00:00.000Z") });
    expect(latestRaw(config, source)?.fetched_at).toBe("2026-10-23T10:00:00.000Z");
  });
});

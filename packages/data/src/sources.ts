import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, resolveProjectPath } from "@sanctions-desk/shared";
import { z } from "zod";
import { ListIdSchema } from "./model.js";

/**
 * The public sanctions-list sources and how to download them. URLs and folders live in
 * config/data-sources.json; nothing here is hard-coded.
 */

export const DataSourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  list: ListIdSchema,
  sanctionsList: z.string().min(1),
  format: z.enum(["ofac-advanced", "un-consolidated"]),
  url: z.url(),
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
});
export type DataSource = z.infer<typeof DataSourceSchema>;

export const DataSourcesConfigSchema = z
  .strictObject({
    userAgent: z.string().min(1),
    requestTimeoutMs: z.number().int().positive(),
    rawDir: z.string().min(1),
    normalisedDir: z.string().min(1),
    sources: z.array(DataSourceSchema).min(1),
  })
  .refine((c) => new Set(c.sources.map((s) => s.id)).size === c.sources.length, "source ids must be unique");
export type DataSourcesConfig = z.infer<typeof DataSourcesConfigSchema>;

export const DEFAULT_SOURCES_FILE = "config/data-sources.json";

export function loadDataSources(path: string = DEFAULT_SOURCES_FILE): DataSourcesConfig {
  const resolved = resolveProjectPath(path);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new AppError("config_missing", `cannot read data sources file ${resolved}`);
  }
  const parsed = DataSourcesConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError("validation", "invalid data sources file", {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return parsed.data;
}

export function findSource(config: DataSourcesConfig, id: string): DataSource {
  const source = config.sources.find((s) => s.id === id);
  if (!source)
    throw new AppError("validation", `unknown data source "${id}"`, {
      details: { known: config.sources.map((s) => s.id) },
    });
  return source;
}

export const FetchRecordSchema = z.strictObject({
  source_id: z.string(),
  url: z.string(),
  file: z.string(),
  fetched_at: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
export type FetchRecord = z.infer<typeof FetchRecordSchema>;

export interface FetchedFile extends FetchRecord {
  /** Absolute path of the downloaded file. */
  path: string;
  /** True when a file for the same day already existed and was reused. */
  reused: boolean;
}

export interface FetchOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function rawFolder(config: DataSourcesConfig, source: DataSource, day: string): string {
  return join(resolveProjectPath(config.rawDir), source.id, day);
}

/**
 * Download a source into data/raw/<source>/<date>/ and record its SHA-256. The file is written to a
 * temporary name and renamed when complete, so an interrupted download never looks finished.
 */
export async function fetchSource(
  config: DataSourcesConfig,
  source: DataSource,
  opts: FetchOptions = {},
): Promise<FetchedFile> {
  const now = (opts.now ?? (() => new Date()))();
  const folder = rawFolder(config, source, now.toISOString().slice(0, 10));
  const target = join(folder, source.file);
  const recordPath = `${target}.fetch.json`;

  if (!opts.force && existsSync(target) && existsSync(recordPath)) {
    const record = FetchRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
    return { ...record, path: target, reused: true };
  }

  mkdirSync(folder, { recursive: true });
  const partial = `${target}.partial`;
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(source.url, {
    headers: { "User-Agent": config.userAgent, Accept: "application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  }).catch((err: unknown) => {
    throw new AppError(
      "network",
      `could not download ${source.id}: ${err instanceof Error ? err.message : String(err)}`,
      { recoverable: true },
    );
  });
  if (!response.ok || !response.body) {
    throw new AppError("http_error", `${source.id} returned HTTP ${response.status}`, {
      recoverable: true,
      details: { url: source.url },
    });
  }

  const hash = createHash("sha256");
  let bytes = 0;
  let head = "";
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (head.length < 64) head += chunk.toString("utf8", 0, Math.min(chunk.length, 64));
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partial));
  } catch (err) {
    rmSync(partial, { force: true });
    throw new AppError(
      "network",
      `download of ${source.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      { recoverable: true },
    );
  }
  if (!head.trimStart().startsWith("<")) {
    rmSync(partial, { force: true });
    throw new AppError("bad_response", `${source.id} did not return XML`, { details: { url: source.url } });
  }
  renameSync(partial, target);

  const record: FetchRecord = {
    source_id: source.id,
    url: source.url,
    file: source.file,
    fetched_at: now.toISOString(),
    sha256: hash.digest("hex"),
    bytes,
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, path: target, reused: false };
}

/** The most recently downloaded raw file of a source, if any. */
export function latestRaw(config: DataSourcesConfig, source: DataSource): FetchedFile | undefined {
  const base = join(resolveProjectPath(config.rawDir), source.id);
  if (!existsSync(base)) return undefined;
  const days = readdirSync(base)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (const day of days.reverse()) {
    const target = join(base, day, source.file);
    const recordPath = `${target}.fetch.json`;
    if (existsSync(target) && existsSync(recordPath)) {
      return { ...FetchRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8"))), path: target, reused: true };
    }
  }
  return undefined;
}

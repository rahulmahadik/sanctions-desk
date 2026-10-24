import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, resolveProjectPath } from "@sanctions-desk/shared";
import {
  type NormalisedSnapshot,
  PARSER_VERSION,
  type SnapshotMeta,
  SnapshotMetaSchema,
  sealEntries,
  TABLE_COLUMNS,
  TABLE_NAMES,
  TABLES,
  type TableName,
  type TableRows,
} from "./model.js";
import { parseOfacFile } from "./ofac.js";
import type { DataSource, DataSourcesConfig, FetchedFile } from "./sources.js";
import { parseUnFile } from "./un.js";

/** Snapshot ids: <source>-<issue date>-<first 8 of the file hash>. The hash tells two same-day files apart. */
export function snapshotIdFor(sourceId: string, issuedOn: string | null, rawSha256: string): string {
  return `${sourceId}-${issuedOn ?? "undated"}-${rawSha256.slice(0, 8)}`;
}

export function countTables(tables: TableRows): Record<string, number> {
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, tables[name].length]));
}

/** Parse a downloaded raw file into the normalised tables, with entry hashes sealed. */
export async function normaliseRaw(source: DataSource, raw: FetchedFile): Promise<NormalisedSnapshot> {
  // The issue date is only known after parsing, so parse with a placeholder id, then stamp the real one.
  const placeholder = "pending";
  const parsed =
    source.format === "ofac-advanced"
      ? await parseOfacFile(raw.path, { snapshotId: placeholder, sanctionsList: source.sanctionsList })
      : await parseUnFile(raw.path, { snapshotId: placeholder, sanctionsList: source.sanctionsList });
  const snapshotId = snapshotIdFor(source.id, parsed.issuedOn, raw.sha256);
  for (const entry of parsed.tables.list_entry) entry.snapshot_id = snapshotId;
  sealEntries(parsed.tables);
  const meta: SnapshotMeta = {
    snapshot_id: snapshotId,
    source_id: source.id,
    list_id: source.list,
    sanctions_list: source.sanctionsList,
    source_url: raw.url,
    fetched_at: raw.fetched_at,
    issued_on: parsed.issuedOn,
    raw_file: raw.file,
    raw_sha256: raw.sha256,
    raw_bytes: raw.bytes,
    parser_version: PARSER_VERSION,
    counts: countTables(parsed.tables),
  };
  return { meta, tables: parsed.tables };
}

// ---- writing and reading ------------------------------------------------------------------

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(name: TableName, rows: readonly object[]): string {
  return csvOf(TABLE_COLUMNS[name], rows);
}

/** CSV text for any flat rows, with the given column order. */
export function csvOf(columns: readonly string[], rows: readonly object[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    lines.push(columns.map((c) => csvCell(record[c])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function sortedRows<T extends object>(name: TableName, rows: readonly T[]): T[] {
  const key = TABLE_COLUMNS[name][0] as string;
  return [...rows].sort((a, b) =>
    String((a as Record<string, unknown>)[key]).localeCompare(String((b as Record<string, unknown>)[key])),
  );
}

/** Write a snapshot as <dir>/<table>.json (one JSON array each), <table>.csv and snapshot.json. */
export function writeSnapshot(dir: string, snapshot: NormalisedSnapshot): void {
  mkdirSync(dir, { recursive: true });
  for (const name of TABLE_NAMES) {
    const rows = sortedRows(name, snapshot.tables[name] as object[]);
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(rows)}\n`);
    writeFileSync(join(dir, `${name}.csv`), toCsv(name, rows));
  }
  writeFileSync(join(dir, "snapshot.json"), `${JSON.stringify(snapshot.meta, null, 2)}\n`);
}

/** Read a snapshot back and validate every row. */
export function readSnapshot(dir: string): NormalisedSnapshot {
  let metaJson: unknown;
  try {
    metaJson = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  } catch {
    throw new AppError("config_missing", `no snapshot found in ${dir}`);
  }
  const meta = SnapshotMetaSchema.parse(metaJson);
  const tables = {} as Record<string, unknown[]>;
  for (const name of TABLE_NAMES) {
    const rows: unknown = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
    tables[name] = TABLES[name].array().parse(rows);
  }
  return { meta, tables: tables as unknown as TableRows };
}

export function snapshotFolder(
  config: DataSourcesConfig,
  meta: Pick<SnapshotMeta, "source_id" | "snapshot_id">,
): string {
  return join(resolveProjectPath(config.normalisedDir), meta.source_id, meta.snapshot_id);
}

/** Folder of the newest snapshot of a source (by issue date, then fetch time), if any. */
export function latestSnapshotDir(config: DataSourcesConfig, sourceId: string): string | undefined {
  const base = join(resolveProjectPath(config.normalisedDir), sourceId);
  if (!existsSync(base)) return undefined;
  const candidates = readdirSync(base)
    .map((name) => join(base, name))
    .filter((dir) => existsSync(join(dir, "snapshot.json")))
    .map((dir) => ({
      dir,
      meta: SnapshotMetaSchema.parse(JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"))),
    }))
    .filter((c) => c.meta.synthetic === undefined);
  candidates.sort((a, b) =>
    `${a.meta.issued_on ?? ""}${a.meta.fetched_at}`.localeCompare(`${b.meta.issued_on ?? ""}${b.meta.fetched_at}`),
  );
  return candidates.at(-1)?.dir;
}

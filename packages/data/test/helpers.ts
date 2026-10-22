import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import {
  type NormalisedSnapshot,
  PARSER_VERSION,
  parseOfacString,
  parseUnString,
  sealEntries,
  snapshotIdFor,
} from "../src/index.js";

/** Returns the first element, failing the test if there is none (avoids non-null assertions). */
export function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected a non-empty list");
  return item;
}

const dirs: string[] = [];

/** A temp directory that is removed after each test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sanctions-desk-data-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const SHA = "a".repeat(64);

function snapshotOf(
  sourceId: string,
  list: "OFAC" | "UN",
  sanctionsList: string,
  parse: (id: string) => { tables: NormalisedSnapshot["tables"]; issuedOn: string | null },
): NormalisedSnapshot {
  const { tables, issuedOn } = parse("pending");
  const id = snapshotIdFor(sourceId, issuedOn, SHA);
  for (const e of tables.list_entry) e.snapshot_id = id;
  sealEntries(tables);
  return {
    meta: {
      snapshot_id: id,
      source_id: sourceId,
      list_id: list,
      sanctions_list: sanctionsList,
      source_url: "https://example.test/list.xml",
      fetched_at: "2026-10-23T00:00:00.000Z",
      issued_on: issuedOn,
      raw_file: "list.xml",
      raw_sha256: SHA,
      raw_bytes: 1000,
      parser_version: PARSER_VERSION,
      counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    },
    tables,
  };
}

/** A normalised snapshot built from the OFAC fixture. */
export function ofacFixtureSnapshot(): NormalisedSnapshot {
  const xml = readFileSync(fixturePath("ofac-mini.xml"), "utf8");
  return snapshotOf("ofac-sdn", "OFAC", "SDN List", (id) =>
    parseOfacString(xml, { snapshotId: id, sanctionsList: "SDN List" }),
  );
}

/** A normalised snapshot built from the UN fixture. */
export function unFixtureSnapshot(): NormalisedSnapshot {
  const xml = readFileSync(fixturePath("un-mini.xml"), "utf8");
  return snapshotOf("un-consolidated", "UN", "UN Security Council Consolidated List", (id) =>
    parseUnString(xml, { snapshotId: id, sanctionsList: "UN Security Council Consolidated List" }),
  );
}

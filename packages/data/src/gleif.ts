import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, resolveProjectPath } from "@sanctions-desk/shared";
import { z } from "zod";
import { ISO_COUNTRIES } from "./countries.js";
import {
  REFERENCE_TABLE_COLUMNS,
  type RefCountryRow,
  type RefLeiRelationshipRow,
  RefLeiRelationshipRowSchema,
  type RefLeiRow,
  RefLeiRowSchema,
} from "./model.js";
import { csvOf } from "./snapshot.js";
import type { DataSourcesConfig } from "./sources.js";

/**
 * A small extract of GLEIF's public LEI data: companies and the parent each one reports. GLEIF
 * publishes the data under CC0 1.0 (https://www.gleif.org/en/meta/lei-data-terms-of-use). The extract
 * gives the synthetic companies real parents to hang ownership chains on.
 */

const NODE_ID = z.string().regex(/^[A-Z0-9]{20}$/);

const LeiRecordSchema = z.object({
  id: NODE_ID,
  attributes: z.object({
    entity: z.object({
      legalName: z.object({ name: z.string().min(1) }),
      legalAddress: z.object({ country: z.string().nullish(), city: z.string().nullish() }).partial(),
      legalForm: z.object({ id: z.string().nullish() }).nullish(),
      category: z.string().nullish(),
      status: z.string().nullish(),
    }),
    registration: z.object({ initialRegistrationDate: z.string().nullish() }).partial(),
  }),
  relationships: z.record(z.string(), z.unknown()),
});
type LeiRecord = z.infer<typeof LeiRecordSchema>;

const RelationshipRecordSchema = z.object({
  attributes: z.object({
    validFrom: z.string().nullish(),
    relationship: z.object({
      startNode: z.object({ id: NODE_ID }),
      endNode: z.object({ id: NODE_ID }),
      type: z.string(),
      status: z.string(),
    }),
    registration: z.object({ corroborationLevel: z.string().nullish() }).partial(),
  }),
});

const ListResponseSchema = z.object({
  meta: z.object({ goldenCopy: z.object({ publishDate: z.string() }) }),
  data: z.array(LeiRecordSchema),
});
const OneResponseSchema = z.object({ data: LeiRecordSchema });
const RelationshipResponseSchema = z.object({ data: RelationshipRecordSchema });

export interface GleifExtract {
  lei: RefLeiRow[];
  relationships: RefLeiRelationshipRow[];
  publishDate: string;
  retrievedAt: string;
}

export interface GleifOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const day = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

function toRow(record: LeiRecord): RefLeiRow {
  const entity = record.attributes.entity;
  const country = entity.legalAddress.country ?? null;
  return RefLeiRowSchema.parse({
    lei: record.id,
    legal_name: entity.legalName.name,
    country_iso2: country && country.length === 2 ? country : null,
    city: entity.legalAddress.city ?? null,
    legal_form_id: entity.legalForm?.id ?? null,
    category: entity.category ?? null,
    entity_status: entity.status ?? null,
    registered_on: day(record.attributes.registration.initialRegistrationDate),
  });
}

function parentLinks(record: LeiRecord): { relationship: string; parent: string } | null {
  const link = z
    .object({ links: z.object({ "relationship-record": z.url(), "lei-record": z.url() }) })
    .safeParse(record.relationships["direct-parent"]);
  return link.success
    ? { relationship: link.data.links["relationship-record"], parent: link.data.links["lei-record"] }
    : null;
}

type JsonGetter = (url: string) => Promise<unknown>;

function makeGetter(config: DataSourcesConfig, options: GleifOptions): JsonGetter {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (url) => {
    await sleep(config.gleif.delayMs);
    const response = await doFetch(url, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": config.userAgent },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }).catch((err: unknown) => {
      throw new AppError("network", `GLEIF request failed: ${err instanceof Error ? err.message : String(err)}`, {
        recoverable: true,
      });
    });
    if (!response.ok)
      throw new AppError("http_error", `GLEIF returned HTTP ${response.status}`, {
        recoverable: true,
        details: { url },
      });
    return response.json();
  };
}

interface Collected {
  records: Map<string, LeiRecord>;
  relationships: Map<string, RefLeiRelationshipRow>;
}

/** Follow one direct-parent link; returns the parent record, or null when there is no active consolidating parent. */
async function followParent(getJson: JsonGetter, found: Collected, child: LeiRecord): Promise<LeiRecord | null> {
  const links = parentLinks(child);
  if (!links) return null;
  const rel = RelationshipResponseSchema.parse(await getJson(links.relationship)).data.attributes;
  if (rel.relationship.type !== "IS_DIRECTLY_CONSOLIDATED_BY" || rel.relationship.status !== "ACTIVE") return null;
  const parent = OneResponseSchema.parse(await getJson(links.parent)).data;
  found.records.set(parent.id, parent);
  const row = RefLeiRelationshipRowSchema.parse({
    relationship_id: `${rel.relationship.startNode.id}|${rel.relationship.endNode.id}|${rel.relationship.type}`,
    child_lei: rel.relationship.startNode.id,
    parent_lei: rel.relationship.endNode.id,
    relationship_type: rel.relationship.type,
    status: rel.relationship.status,
    valid_from: day(rel.validFrom),
    corroboration_level: rel.registration.corroborationLevel ?? null,
  });
  found.relationships.set(row.relationship_id, row);
  return parent;
}

function countryQuery(g: DataSourcesConfig["gleif"], country: string): string {
  const query = new URLSearchParams({
    "filter[entity.legalAddress.country]": country,
    "filter[entity.category]": "GENERAL",
    "filter[registration.status]": "ISSUED",
    "filter[entity.status]": "ACTIVE",
    "page[size]": String(g.scanPageSize),
  });
  return `${g.baseUrl}/lei-records?${query}`;
}

/** Collect companies with a reported parent, then follow parent links upward for a few levels. */
export async function fetchGleifExtract(config: DataSourcesConfig, options: GleifOptions = {}): Promise<GleifExtract> {
  const g = config.gleif;
  const getJson = makeGetter(config, options);
  const found: Collected = { records: new Map(), relationships: new Map() };
  let publishDate = "";
  let children = 0;

  for (const country of g.countries) {
    if (children >= g.maxChildren) break;
    const page = ListResponseSchema.parse(await getJson(countryQuery(g, country)));
    publishDate = page.meta.goldenCopy.publishDate;
    for (const record of page.data.filter((r) => parentLinks(r) !== null)) {
      if (children >= g.maxChildren) break;
      found.records.set(record.id, record);
      children += 1;
      let current: LeiRecord | null = record;
      for (let level = 0; level < g.parentDepth && current; level += 1) {
        current = await followParent(getJson, found, current);
      }
    }
  }

  return {
    lei: [...found.records.values()].map(toRow).sort((a, b) => a.lei.localeCompare(b.lei)),
    relationships: [...found.relationships.values()].sort((a, b) => a.relationship_id.localeCompare(b.relationship_id)),
    publishDate,
    retrievedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function refCountryRows(): RefCountryRow[] {
  return ISO_COUNTRIES.map(([iso2, name]) => ({ iso2, name }));
}

/** Write the extract (and the country reference table) with its licence and source in `extract.json`. */
export function writeGleifExtract(config: DataSourcesConfig, extract: GleifExtract, outDir?: string): string {
  const dir = outDir ?? resolveProjectPath(config.gleif.outputDir);
  mkdirSync(dir, { recursive: true });
  const tables = {
    ref_country: refCountryRows(),
    ref_lei: extract.lei,
    ref_lei_relationship: extract.relationships,
  } as const;
  for (const [name, rows] of Object.entries(tables)) {
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(rows)}\n`);
    writeFileSync(join(dir, `${name}.csv`), csvOf(REFERENCE_TABLE_COLUMNS[name as keyof typeof tables], rows));
  }
  const meta = {
    source: "GLEIF Global LEI Index (public API)",
    source_url: config.gleif.baseUrl,
    licence: config.gleif.licence,
    terms_url: config.gleif.termsUrl,
    golden_copy_publish_date: extract.publishDate,
    retrieved_at: extract.retrievedAt,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    note: "A small sample of companies that report a direct parent. Not a complete extract.",
  };
  writeFileSync(join(dir, "extract.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return dir;
}

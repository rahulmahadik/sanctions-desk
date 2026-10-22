import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DataSourcesConfig,
  fetchGleifExtract,
  loadDataSources,
  refCountryRows,
  writeGleifExtract,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const lei = (n: number) => `LEI${String(n).padStart(17, "0")}`.slice(0, 20);
const BASE = "https://gleif.test/api/v1";

function record(id: string, name: string, parent?: string) {
  return {
    id,
    attributes: {
      entity: {
        legalName: { name },
        legalAddress: { country: "GB", city: "London" },
        legalForm: { id: "H0PO" },
        category: "GENERAL",
        status: "ACTIVE",
      },
      registration: { initialRegistrationDate: "2015-03-01T00:00:00Z" },
    },
    relationships: parent
      ? {
          "direct-parent": {
            links: { "relationship-record": `${BASE}/rel/${id}`, "lei-record": `${BASE}/lei-records/${parent}` },
          },
        }
      : {},
  };
}

function relationship(child: string, parent: string, status = "ACTIVE", type = "IS_DIRECTLY_CONSOLIDATED_BY") {
  return {
    data: {
      attributes: {
        validFrom: "2020-01-02T00:00:00Z",
        relationship: { startNode: { id: child }, endNode: { id: parent }, type, status },
        registration: { corroborationLevel: "FULLY_CORROBORATED" },
      },
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function config(over: Partial<DataSourcesConfig["gleif"]> = {}): DataSourcesConfig {
  const base = loadDataSources();
  return { ...base, gleif: { ...base.gleif, baseUrl: BASE, countries: ["GB"], delayMs: 0, ...over } };
}

function fakeApi(handler: (url: string) => Response): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const CHILD = lei(1);
const PARENT = lei(2);
const GRAND = lei(3);

function standardApi() {
  return fakeApi((url) => {
    if (url.includes("/lei-records?"))
      return json({
        meta: { goldenCopy: { publishDate: "2026-10-22T08:00:00Z" } },
        data: [record(CHILD, "Child Ltd", PARENT), record(lei(9), "Loner Ltd")],
      });
    if (url.endsWith(`/rel/${CHILD}`)) return json(relationship(CHILD, PARENT));
    if (url.endsWith(`/rel/${PARENT}`)) return json(relationship(PARENT, GRAND));
    if (url.endsWith(`/lei-records/${PARENT}`)) return json({ data: record(PARENT, "Parent Plc", GRAND) });
    if (url.endsWith(`/lei-records/${GRAND}`)) return json({ data: record(GRAND, "Grand Holdings") });
    return json({}, 404);
  });
}

describe("fetchGleifExtract", () => {
  it("keeps companies that report a parent and follows the chain upward", async () => {
    const api = standardApi();
    const out = await fetchGleifExtract(config(), {
      fetchImpl: api.fetchImpl,
      now: () => new Date("2026-10-23T00:00:00Z"),
    });
    expect(out.lei.map((r) => r.legal_name)).toEqual(["Child Ltd", "Parent Plc", "Grand Holdings"]);
    expect(out.relationships.map((r) => [r.child_lei, r.parent_lei])).toEqual([
      [CHILD, PARENT],
      [PARENT, GRAND],
    ]);
    expect(out.relationships[0]).toMatchObject({ status: "ACTIVE", valid_from: "2020-01-02" });
    expect(out.publishDate).toBe("2026-10-22T08:00:00Z");
    expect(out.retrievedAt).toBe("2026-10-23T00:00:00.000Z");
    expect(out.lei[0]).toMatchObject({ country_iso2: "GB", registered_on: "2015-03-01" });
  });

  it("stops following parents at the configured depth", async () => {
    const out = await fetchGleifExtract(config({ parentDepth: 1 }), { fetchImpl: standardApi().fetchImpl });
    expect(out.relationships).toHaveLength(1);
  });

  it("stops after the configured number of companies", async () => {
    const api = fakeApi((url) =>
      url.includes("/lei-records?")
        ? json({
            meta: { goldenCopy: { publishDate: "2026-10-22T08:00:00Z" } },
            data: [record(CHILD, "Child Ltd", PARENT), record(lei(5), "Other Ltd", PARENT)],
          })
        : url.includes("/rel/")
          ? json(relationship(CHILD, PARENT, "INACTIVE"))
          : json({}, 404),
    );
    const out = await fetchGleifExtract(config({ maxChildren: 1, countries: ["GB", "DE"] }), {
      fetchImpl: api.fetchImpl,
    });
    expect(out.lei.map((r) => r.lei)).toEqual([CHILD]);
    expect(api.urls.filter((u) => u.includes("/lei-records?"))).toHaveLength(1);
  });

  it("ignores inactive or other relationship types", async () => {
    const api = fakeApi((url) => {
      if (url.includes("/lei-records?"))
        return json({ meta: { goldenCopy: { publishDate: "d" } }, data: [record(CHILD, "Child Ltd", PARENT)] });
      return json(relationship(CHILD, PARENT, "ACTIVE", "IS_ULTIMATELY_CONSOLIDATED_BY"));
    });
    const out = await fetchGleifExtract(config(), { fetchImpl: api.fetchImpl });
    expect(out.relationships).toHaveLength(0);
    expect(out.lei.map((r) => r.lei)).toEqual([CHILD]);
  });

  it("reports HTTP errors and network failures as recoverable", async () => {
    const down = fakeApi(() => json({}, 503));
    await expect(fetchGleifExtract(config(), { fetchImpl: down.fetchImpl })).rejects.toMatchObject({
      type: "http_error",
      recoverable: true,
    });
    const broken = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(fetchGleifExtract(config(), { fetchImpl: broken })).rejects.toMatchObject({ type: "network" });
  });
});

describe("writeGleifExtract", () => {
  it("writes json and csv per table with the licence in extract.json", async () => {
    const extract = await fetchGleifExtract(config(), { fetchImpl: standardApi().fetchImpl });
    const dir = writeGleifExtract(config(), extract, tempDir());
    for (const name of ["ref_country", "ref_lei", "ref_lei_relationship"]) {
      expect(existsSync(join(dir, `${name}.json`))).toBe(true);
      expect(existsSync(join(dir, `${name}.csv`))).toBe(true);
    }
    const meta = JSON.parse(readFileSync(join(dir, "extract.json"), "utf8"));
    expect(meta).toMatchObject({ licence: "CC0 1.0", counts: { ref_lei: 3, ref_lei_relationship: 2 } });
    expect(readFileSync(join(dir, "ref_lei.csv"), "utf8").split("\n")[0]).toContain("lei,legal_name");
  });

  it("lists the country reference rows", () => {
    expect(refCountryRows().find((r) => r.iso2 === "CU")).toBeDefined();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createZetarisClient } from "../src/client.js";
import { loadUslModel, parseUslModel } from "../src/metadata.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const model = JSON.parse(readFileSync(new URL("./fixtures/usl-model.json", import.meta.url), "utf8"));

describe("parseUslModel", () => {
  const parsed = parseUslModel(model);
  const table = (name: string) => parsed.tables.find((t) => t.name === name);

  it("reads the model, its tables and the qualified names", () => {
    expect(parsed.name).toBe("screening_usl");
    expect(parsed.namespace).toBe("lightning.metastore.sanctions");
    expect(parsed.tables.map((t) => t.name)).toEqual([
      "list_entry",
      "list_alias",
      "list_dob",
      "list_country",
      "list_identifier",
      "customer",
      "customer_identifier",
      "alert",
    ]);
    expect(table("alert")?.qualifiedName).toBe("lightning.metastore.sanctions.screening_usl.alert");
    expect(parsed.tables.every((t) => t.activated)).toBe(true);
    expect(parsed.version).toMatch(/^[a-f0-9]{12}$/);
  });

  it("reads types, keys, descriptions and relationships", () => {
    const alert = table("alert");
    expect(alert?.columns.find((c) => c.name === "alert_id")).toMatchObject({
      type: "varchar(32)",
      primaryKey: true,
      notNull: true,
    });
    expect(alert?.columns.find((c) => c.name === "customer_id")?.references).toEqual({
      table: "lightning.metastore.sanctions.screening_usl.customer",
      column: "customer_id",
    });
    expect(alert?.columns.find((c) => c.name === "payment_id")).toMatchObject({ notNull: false, primaryKey: false });
    expect(alert?.columns.find((c) => c.name === "match_score")?.type).toBe("decimal(4,3)");
    expect(alert?.description).toContain("Screening alerts");
    expect(table("list_dob")?.columns.some((c) => c.name === "dob_precision")).toBe(true);
  });

  it("reads the data-quality rules written on a table", () => {
    expect(table("alert")?.dqRules).toEqual([
      { name: "match_score_in_range", expression: "match_score >= 0 AND match_score <= 1" },
    ]);
    expect(
      table("customer")
        ?.dqRules.map((r) => r.name)
        .sort(),
    ).toEqual(["dob_present_for_individuals", "nationality_is_iso2"]);
  });

  it("changes version when the model changes", () => {
    const changed = structuredClone(model);
    changed.tables[0].description = "different";
    expect(parseUslModel(changed).version).not.toBe(parsed.version);
  });

  it("rejects a description with the wrong shape", () => {
    expect(() => parseUslModel({ name: "x" })).toThrow(/unexpected shape/);
    expect(() => parseUslModel(null)).toThrow(/unexpected shape/);
  });

  it("treats a table without an activation query as not activated", () => {
    const draft = structuredClone(model);
    delete draft.tables[0].activateQuery;
    expect(parseUslModel(draft).tables[0]?.activated).toBe(false);
  });
});

describe("loadUslModel", () => {
  it("reads the model through the client and allows only its activated tables", async () => {
    const draft = structuredClone(model);
    delete draft.tables.find((t: { name: string }) => t.name === "alert").activateQuery;
    const api = fakeZetaris(() => ({ body: rowsOf(["json"], [[JSON.stringify(draft)]]) }));
    const client = createZetarisClient({
      config: testConfig({ ZETARIS_TOKEN_EVIDENCE: "e-token" }),
      fetchImpl: api.fetchImpl,
    });
    const { model: loaded, query } = await loadUslModel(
      client,
      "evidence",
      "lightning.metastore.sanctions",
      "screening_usl",
    );
    expect(api.sent[0]?.body.sql).toBe("LOAD USL screening_usl NAMESPACE lightning.metastore.sanctions");
    expect(query.kind).toBe("metadata");
    expect(loaded.tables).toHaveLength(8);
    expect(client.allowedTables()).toHaveLength(7);
    expect(client.allowedTables()).not.toContain("lightning.metastore.sanctions.screening_usl.alert");
  });

  it("fails clearly when the answer is empty or not JSON", async () => {
    for (const cell of [null, "not json"]) {
      const api = fakeZetaris(() => ({ body: rowsOf(["json"], [[cell]]) }));
      const client = createZetarisClient({
        config: testConfig({ ZETARIS_TOKEN_EVIDENCE: "e-token" }),
        fetchImpl: api.fetchImpl,
      });
      await expect(
        loadUslModel(client, "evidence", "lightning.metastore.sanctions", "screening_usl"),
      ).rejects.toMatchObject({
        type: "bad_response",
      });
    }
  });
});

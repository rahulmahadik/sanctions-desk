import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createZetarisClient } from "../src/client.js";
import { parseUslModel } from "../src/metadata.js";
import { buildEvidenceTools, isSensitive, maskValue, quoteLiteral } from "../src/tools.js";
import { fakeZetaris, rowsOf, testConfig } from "./helpers.js";

const model = parseUslModel(JSON.parse(readFileSync(new URL("./fixtures/usl-model.json", import.meta.url), "utf8")));

function setup(answer: (sql: string) => { body: unknown; status?: number }, maskSensitive = true) {
  const api = fakeZetaris(answer);
  const client = createZetarisClient({
    config: testConfig({ ZETARIS_TOKEN_EVIDENCE: "e-token" }),
    fetchImpl: api.fetchImpl,
  });
  client.setAllowedTables(model.tables.map((t) => t.qualifiedName));
  const tools = buildEvidenceTools(model, client, { role: "evidence", defaultLimit: 50, maskSensitive });
  return { api, tools };
}

describe("maskValue", () => {
  it("keeps the last two characters and hides the rest", () => {
    expect(maskValue("AB1234567")).toBe("*******67");
    expect(maskValue("1234")).toBe("****");
    expect(maskValue("")).toBe("");
    expect(maskValue(null)).toBeNull();
    expect(maskValue("A".repeat(40))?.length).toBe(10);
  });
});

describe("quoteLiteral", () => {
  it("doubles quotes and refuses characters the guard would refuse anyway", () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
    expect(() => quoteLiteral("a;b")).toThrow(/not allowed/);
    expect(() => quoteLiteral("a\nb")).toThrow(/not allowed/);
    expect(() => quoteLiteral("abc\\")).toThrow(/not allowed/);
    expect(() => quoteLiteral("a\\'b")).toThrow(/not allowed/);
    expect(() => quoteLiteral(`\${x}`)).toThrow(/not allowed/);
  });
});

describe("buildEvidenceTools", () => {
  it("makes one tool per activated table, described from the model", () => {
    const { tools } = setup(() => ({ body: rowsOf([], []) }));
    expect([...tools.keys()]).toEqual([
      "find_list_entry",
      "find_list_alias",
      "find_list_dob",
      "find_list_country",
      "find_list_identifier",
      "find_customer",
      "find_customer_identifier",
      "find_alert",
    ]);
    const alert = tools.get("find_alert");
    expect(alert?.description).toContain("Screening alerts");
    expect(alert?.description).toContain("key: alert_id");
    expect(alert?.description).toContain("customer_id -> customer");
  });

  it("builds a quoted, ordered, limited select and returns rows with keys and hashes", async () => {
    const { api, tools } = setup(() => ({
      body: rowsOf(["customer_id", "full_name"], [["CUST-001", "Bassem Murad"]]),
    }));
    const result = await tools.get("find_customer")?.find({ customer_id: "CUST-001" });
    const sql = api.sent[0]?.body.sql ?? "";
    expect(sql).toContain(
      "FROM lightning.metastore.sanctions.screening_usl.customer WHERE `customer_id` = 'CUST-001' ORDER BY `customer_id` LIMIT 50",
    );
    expect(result?.rows).toHaveLength(1);
    expect(result?.rowKeys).toEqual(["CUST-001"]);
    expect(result?.rowHashes[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.query.role).toBe("evidence");
  });

  it("masks columns marked sensitive for the evidence role but hashes the real row", async () => {
    const row = ["IDN-1", "CUST-1", "passport", "AB1234567", "RU"];
    const answer = () => ({
      body: rowsOf(["identifier_id", "customer_id", "id_type", "id_number", "issuing_country"], [row]),
    });
    const masked = await setup(answer).tools.get("find_customer_identifier")?.find({ customer_id: "CUST-1" });
    expect(masked?.rows[0]?.id_number).toBe("*******67");
    expect(masked?.maskedColumns).toEqual(["id_number"]);
    const open = await setup(answer, false).tools.get("find_customer_identifier")?.find({ customer_id: "CUST-1" });
    expect(open?.rows[0]?.id_number).toBe("AB1234567");
    expect(open?.rowHashes).toEqual(masked?.rowHashes);
  });

  it("does not mask public list identifiers", () => {
    const column = model.tables.find((t) => t.name === "list_identifier")?.columns.find((c) => c.name === "id_number");
    expect(column && isSensitive(column)).toBe(false);
    const own = model.tables.find((t) => t.name === "customer_identifier")?.columns.find((c) => c.name === "id_number");
    expect(own && isSensitive(own)).toBe(true);
  });

  it("rejects calls with no filter or an unknown column, and caps the limit", async () => {
    const { api, tools } = setup(() => ({ body: rowsOf(["a"], []) }));
    const tool = tools.get("find_customer");
    await expect(tool?.find({})).rejects.toMatchObject({ type: "validation" });
    await expect(tool?.find({ nope: "x" })).rejects.toMatchObject({ type: "validation" });
    await tool?.find({ customer_id: "C" }, { limit: 9999 });
    expect(api.sent[0]?.body.sql).toContain("LIMIT 50");
  });
});

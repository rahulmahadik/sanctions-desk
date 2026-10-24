import { RunIdSchema } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { SAFE_ID_PATTERN, SafeIdSchema } from "../src/ids.js";
import { ROUTES } from "../src/openapi.js";
import { makeApp } from "./helpers.js";

const documented = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path.replace(/\{(\w+)\}/g, ":$1")}`));

/** The schema the description gives for a path parameter. */
function paramSchema(path: string, name: string): { pattern: string; minLength?: number; maxLength?: number } {
  const route = ROUTES.find((r) => r.path === path);
  const param = route?.params?.find((p) => p.name === name) as { schema?: unknown } | undefined;
  return param?.schema as { pattern: string; minLength?: number; maxLength?: number };
}

/** True when the documented schema accepts the id: the pattern matches and the length is within the stated bounds. */
const documentedAccepts = (schema: ReturnType<typeof paramSchema>, id: string): boolean =>
  new RegExp(schema.pattern).test(id) &&
  id.length >= (schema.minLength ?? 0) &&
  id.length <= (schema.maxLength ?? Number.POSITIVE_INFINITY);

describe("the API description", () => {
  it("describes alert and run ids with the pattern and lengths the routes validate with", () => {
    expect(paramSchema("/cases/{alertId}/record", "alertId").pattern).toBe(SAFE_ID_PATTERN.source);
    const run = paramSchema("/runs/{runId}/events", "runId");
    expect(run.minLength).toBe(RunIdSchema.minLength);
    expect(run.maxLength).toBe(RunIdSchema.maxLength);
    // The description and the validator agree on every id, including the longest one the validator accepts.
    for (const id of ["ui-ALR-0001-1761300000000", "a".repeat(100), "a".repeat(101), "a b", "", "x/y", ".hidden"]) {
      expect(documentedAccepts(run, id), `run id ${JSON.stringify(id)}`).toBe(RunIdSchema.safeParse(id).success);
      expect(documentedAccepts(paramSchema("/cases/{alertId}/record", "alertId"), id), `alert id ${id}`).toBe(
        SafeIdSchema.safeParse(id).success,
      );
    }
  });

  it("covers every route the API registers, so a new route cannot go undocumented", async () => {
    const { app } = await makeApp();
    const registered = (app as unknown as { routeTable: string[] }).routeTable.filter(
      (r) => !r.includes(" /docs") && !r.endsWith(" *"),
    );
    expect(registered.length).toBeGreaterThan(20);
    const missing = registered.filter((r) => !documented.has(r));
    expect(missing).toEqual([]);
    const stale = [...documented].filter((d) => !registered.includes(d));
    expect(stale).toEqual([]);
  });

  it("serves the description and the Swagger page, built from the same schemas the routes validate with", async () => {
    const { app } = await makeApp();
    const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json() as {
      openapi: string;
      info: { title: string };
      paths: Record<
        string,
        Record<
          string,
          { requestBody?: { content: { "application/json": { schema: { properties?: Record<string, unknown> } } } } }
        >
      >;
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Sanctions Desk API");
    expect(Object.keys(spec.paths)).toContain("/policy/whatif");
    const runBody = spec.paths["/run"]?.post?.requestBody?.content["application/json"].schema;
    expect(Object.keys(runBody?.properties ?? {})).toEqual(expect.arrayContaining(["alert_id", "run_id"]));
    const page = await app.inject({ method: "GET", url: "/docs/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
  });

  it("can be switched off", async () => {
    const { app } = await makeApp({ env: { DOCS_ENABLED: "false" } });
    expect((await app.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/docs/" })).statusCode).toBe(404);
  });
});

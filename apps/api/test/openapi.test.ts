import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/openapi.js";
import { makeApp } from "./helpers.js";

const documented = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path.replace(/\{(\w+)\}/g, ":$1")}`));

describe("the API description", () => {
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
    expect(spec.info.title).toBe("sanctions-desk API");
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

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

describe("authentication in the API description", () => {
  it("declares a bearer scheme, marks /health public, and names each route's roles from the same rules the API enforces", async () => {
    const { buildOpenApi } = await import("../src/openapi.js");
    const doc = buildOpenApi("test") as {
      components: { securitySchemes: { bearerAuth: { scheme: string } } };
      paths: Record<
        string,
        Record<
          string,
          { "x-required-roles": unknown; security?: unknown[]; responses: Record<string, unknown>; description: string }
        >
      >;
    };
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(doc.paths["/health"]?.get?.["x-required-roles"]).toBe("public");
    expect(doc.paths["/health"]?.get?.security).toEqual([]);
    expect(doc.paths["/run"]?.post?.["x-required-roles"]).toEqual(["analyst", "approver", "policy_admin"]);
    expect(doc.paths["/policy/drafts/{version}/publish"]?.post?.["x-required-roles"]).toEqual(["policy_admin"]);
    expect(doc.paths["/cases/{alertId}/decision"]?.post?.description).toMatch(/Four-eyes/);
    expect(doc.paths["/alerts"]?.get?.["x-required-roles"]).toBe("any");
    expect(Object.keys(doc.paths["/run"]?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(["401", "403", "429"]),
    );
  });
});

describe("the authentication section", () => {
  it("is the same text in docs/API.md and in the API description, with a placeholder token only", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolveProjectPath } = await import("@sanctions-desk/shared");
    const { AUTH_GUIDE } = await import("../src/auth-guide.js");
    const { buildOpenApi } = await import("../src/openapi.js");
    // The Markdown formatter aligns the table, so compare with runs of spaces and dashes collapsed.
    const flat = (s: string) => s.replace(/ +/g, " ").replace(/-{3,}/g, "---");
    expect(flat(readFileSync(resolveProjectPath("docs/API.md"), "utf8"))).toContain(flat(AUTH_GUIDE));
    expect((buildOpenApi("t") as { info: { description: string } }).info.description).toContain(AUTH_GUIDE);
    expect(AUTH_GUIDE).toContain("Bearer $DESK_TOKEN");
    expect(AUTH_GUIDE).not.toMatch(/sd_[A-Za-z0-9_-]{32}(?![A-Z_])/);
  });
});

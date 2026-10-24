import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Service {
  image?: string;
  ports?: unknown[];
  networks?: string[] | Record<string, unknown>;
  profiles?: string[];
  healthcheck?: unknown;
  environment?: Record<string, string>;
  volumes?: string[];
  build?: { target?: string };
}
const compose = parse(readFileSync(resolveProjectPath("docker-compose.yml"), "utf8")) as {
  services: Record<string, Service>;
  networks: Record<string, { external?: boolean; name?: string }>;
};
const networksOf = (s: Service): string[] => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}));

describe("compose: the data services are reachable by Zetaris alone", () => {
  const data = ["bankdb", "payments-api"] as const;

  it("joins them to the existing Zetaris network and nothing else", () => {
    expect(compose.networks.zetaris).toMatchObject({ external: true, name: "zetaris_default" });
    for (const name of data) expect(networksOf(compose.services[name] as Service), name).toEqual(["zetaris"]);
  });

  it("publishes no host port for them", () => {
    for (const name of data) expect((compose.services[name] as Service).ports, name).toBeUndefined();
  });

  it("keeps the review API off the Zetaris network", () => {
    const api = compose.services.api as Service;
    expect(networksOf(api)).not.toContain("zetaris");
    expect(api.ports).toBeDefined();
  });

  it("sets HOST for the api service, since the default outside a container is 127.0.0.1", () => {
    expect((compose.services.api as Service).environment?.HOST).toBe("0.0.0.0");
  });

  it("starts them only in the data profile, so a clean clone runs the API alone", () => {
    for (const name of data) expect((compose.services[name] as Service).profiles, name).toEqual(["data"]);
    expect((compose.services.api as Service).profiles).toBeUndefined();
  });

  it("takes passwords and keys from the environment, never from the file", () => {
    const text = readFileSync(resolveProjectPath("docker-compose.yml"), "utf8");
    expect(text).toMatch(/POSTGRES_PASSWORD: \$\{BANKDB_ADMIN_PASSWORD/);
    expect(text).toMatch(/PAYMENTS_API_KEY: \$\{PAYMENTS_API_KEY/);
    for (const line of text.split("\n").filter((l) => /PASSWORD|API_KEY/.test(l) && !l.trim().startsWith("#"))) {
      expect(line, line).toMatch(/\$\{[A-Z_]+(:-)?\}|\$\{[A-Z_]+:-\}/);
    }
  });

  it("has health checks, a pinned database image, and read-only mounts for seed data", () => {
    const bankdb = compose.services.bankdb as Service;
    expect(bankdb.healthcheck).toBeDefined();
    // Pinned by version tag and digest, so a moved tag cannot change the database image.
    expect(bankdb.image).toMatch(/^postgres:\d+-alpine@sha256:[0-9a-f]{64}$/);
    expect(
      (bankdb.volumes ?? []).filter((v) => v.includes("/seed") || v.includes("initdb")).every((v) => v.endsWith(":ro")),
    ).toBe(true);
    expect(((compose.services["payments-api"] as Service).volumes ?? []).every((v) => v.endsWith(":ro"))).toBe(true);
  });
});

describe("the bankdb scripts", () => {
  it("create a read-only login for Zetaris using a password from the environment", () => {
    const script = readFileSync(resolveProjectPath("docker/bankdb/init/03_reader.sh"), "utf8");
    expect(script).toContain("BANKDB_READER_PASSWORD");
    expect(script).toContain("default_transaction_read_only = on");
    expect(script).toContain("GRANT SELECT ON ALL TABLES");
    expect(script).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)/);
  });
});

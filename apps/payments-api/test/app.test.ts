import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { buildPaymentsApp } from "../src/app.js";

const payments = JSON.parse(readFileSync(resolveProjectPath("data/synthetic/payment.json"), "utf8"));

describe("payments api", () => {
  it("answers /payments with a JSON array of all payments", async () => {
    const app = buildPaymentsApp({ payments });
    const res = await app.inject({ method: "GET", url: "/payments" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json()).toHaveLength(payments.length);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("filters by customer and status, and returns one payment as a one-item array", async () => {
    const app = buildPaymentsApp({ payments });
    const first = payments[0];
    const byCustomer = await app.inject({ method: "GET", url: `/payments?customer_id=${first.customer_id}` });
    expect(byCustomer.json().every((p: { customer_id: string }) => p.customer_id === first.customer_id)).toBe(true);
    const none = await app.inject({ method: "GET", url: "/payments?status=released" });
    expect(none.json()).toEqual([]);
    const one = await app.inject({ method: "GET", url: `/payments/${first.payment_id}` });
    expect(one.json()).toEqual([first]);
    expect((await app.inject({ method: "GET", url: "/payments/PAY-99999" })).statusCode).toBe(404);
  });

  it("refuses everything that is not a read", async () => {
    const app = buildPaymentsApp({ payments });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/payments" });
      expect(res.statusCode, method).toBe(405);
      expect(res.headers.allow).toBe("GET");
    }
  });

  it("requires the key when one is configured, except for the health check", async () => {
    const app = buildPaymentsApp({ payments, apiKey: "local-test-key" });
    expect((await app.inject({ method: "GET", url: "/payments" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/payments", headers: { "x-api-key": "wrong-key-value" } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/payments", headers: { "x-api-key": "local-test-key" } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok" });
  });

  it("rejects data that is not payments", () => {
    expect(() => buildPaymentsApp({ payments: [{ payment_id: "x" }] })).toThrow();
  });
});

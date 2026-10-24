import { timingSafeEqual } from "node:crypto";
import { type PaymentRow, PaymentRowSchema } from "@sanctions-desk/data";
import fastify from "fastify";

/**
 * A small read-only payments service over the synthetic payments. It stands in for a bank's payment
 * system: JSON arrays over GET, nothing that writes. Zetaris reads it as a REST table; the review
 * application never calls it directly.
 */

interface PaymentsAppOptions {
  payments: readonly unknown[];
  /** When set, every data request must carry this key in the x-api-key header. */
  apiKey?: string;
}

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function buildPaymentsApp(options: PaymentsAppOptions) {
  const payments: PaymentRow[] = PaymentRowSchema.array().parse(options.payments);
  const app = fastify({ logger: false, bodyLimit: 1024 });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (req.method !== "GET") return reply.status(405).header("allow", "GET").send({ error: "read-only service" });
    if (req.url === "/health") return undefined;
    if (options.apiKey !== undefined) {
      const given = req.headers["x-api-key"];
      if (typeof given !== "string" || !safeEqual(given, options.apiKey)) {
        return reply.status(401).send({ error: "a valid x-api-key header is required" });
      }
    }
    return undefined;
  });

  app.get("/health", async () => ({ status: "ok", payments: payments.length }));

  app.get<{ Querystring: { customer_id?: string; status?: string } }>("/payments", async (req) => {
    const { customer_id, status } = req.query;
    return payments.filter(
      (p) =>
        (customer_id === undefined || p.customer_id === customer_id) && (status === undefined || p.status === status),
    );
  });

  app.get<{ Params: { id: string } }>("/payments/:id", async (req, reply) => {
    const found = payments.find((p) => p.payment_id === req.params.id);
    return found ? [found] : reply.status(404).send({ error: "no such payment" });
  });

  return app;
}

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { config } from "./config.js";
import { policies } from "../core/policies.js";
import { DeskError, DeskService } from "./service.js";
import { PayPalError } from "./paypal.js";
import { ledgerRow, reconcile } from "./reconcile.js";

const messageSchema = z
  .object({
    sender: z.string().min(1).max(100),
    email: z.string().email().max(200),
    subject: z.string().min(1).max(200),
    message: z.string().min(5).max(15000),
  })
  .strict();
const editSchema = z
  .object({
    orderId: z.string().min(1).optional(),
    approvedCents: z.number().int().positive().optional(),
    clauseIds: z.array(z.string()).max(8).optional(),
    damagedLineIds: z.array(z.string()).max(30).optional(),
    hasDamageEvidence: z.boolean().optional(),
    returnReceivedLineIds: z.array(z.string()).max(30).optional(),
    duplicateOverride: z.string().min(8).max(1000).nullable().optional(),
    replyDraft: z.string().max(8000).optional(),
    replySent: z.boolean().optional(),
  })
  .strict();

export function createApp(service: DeskService) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof PayPalError)
      return c.json({ error: error.toJSON() }, 502);
    if (error instanceof z.ZodError)
      return c.json(
        { error: { message: "Invalid input", details: error.issues } },
        400,
      );
    if (error instanceof DeskError)
      return c.json({ error: { message: error.message } }, error.status as 400);
    return c.json(
      {
        error: {
          message:
            error instanceof SyntaxError
              ? "Invalid JSON"
              : error.message || "Request failed",
        },
      },
      error instanceof SyntaxError ? 400 : 500,
    );
  });
  app.use("/api/*", async (c, next) => {
    // Single local owner. Reject browser cross-origin mutations; deployed auth is explicitly out of scope.
    const origin = c.req.header("origin");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.path !== "/api/webhooks/paypal" &&
      origin &&
      origin !== new URL(c.req.url).origin &&
      !["http://localhost:15481", "http://127.0.0.1:15481"].includes(origin)
    )
      return c.json(
        { error: { message: "Cross-origin request rejected" } },
        403,
      );
    if (Number(c.req.header("content-length") || 0) > 1000000)
      return c.json({ error: { message: "Request is too large" } }, 413);
    await next();
  });
  app.get("/api/health", (c) =>
    c.json({ ok: true, aiMode: config.aiMode, environment: "sandbox" }),
  );
  app.get("/api/policies", (c) => c.json(policies));
  app.get("/api/orders", (c) => {
    const query = c.req.query("q");
    return c.json(
      query
        ? service.store
            .listOrders()
            .filter((order) =>
              `${order.id} ${order.customerName} ${order.email}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
        : service.store.listOrders(),
    );
  });
  app.get("/api/cases", (c) =>
    c.json(service.store.listCases().map((value) => service.detail(value.id))),
  );
  app.get("/api/cases/:id", (c) => c.json(service.detail(c.req.param("id"))));
  app.post("/api/cases", async (c) =>
    c.json(service.createMessage(messageSchema.parse(await c.req.json())), 201),
  );
  app.post("/api/inbox/import", async (c) => {
    const inputs = z
      .array(messageSchema)
      .min(1)
      .max(100)
      .parse(await c.req.json());
    return c.json(
      service.store.transaction(() =>
        inputs.map((input) => service.createMessage(input)),
      ),
      201,
    );
  });
  app.patch("/api/cases/:id", async (c) =>
    c.json(
      service.edit(c.req.param("id"), editSchema.parse(await c.req.json())),
    ),
  );
  app.post("/api/cases/:id/triage", async (c) =>
    c.json(await service.triageCase(c.req.param("id"))),
  );
  app.post("/api/triage", async (c) => {
    const results = [];
    for (const value of service.store
      .listCases()
      .filter((value) => value.status === "new"))
      results.push(await service.triageCase(value.id));
    return c.json(results);
  });
  app.post("/api/cases/:id/approve", async (c) =>
    c.json(await service.approve(c.req.param("id"))),
  );
  app.post("/api/cases/:id/reject", (c) =>
    c.json(service.reject(c.req.param("id"))),
  );
  app.get("/api/ledger", (c) =>
    c.json(
      service.store
        .listOrders()
        .map((order) => ledgerRow(service.store, order.id)),
    ),
  );
  app.post("/api/orders/:id/reconcile", async (c) => {
    if (!service.store.getOrder(c.req.param("id")))
      throw new DeskError("Order not found", 404);
    return c.json(
      await reconcile(service.store, service.paypal, c.req.param("id")),
    );
  });
  app.post("/api/reconcile", async (c) => {
    const rows = [];
    for (const order of service.store.listOrders()) {
      try {
        rows.push(await reconcile(service.store, service.paypal, order.id));
      } catch {
        rows.push(ledgerRow(service.store, order.id));
      }
    }
    return c.json(rows);
  });
  app.post("/api/webhooks/paypal", async (c) => {
    const event = z
      .object({
        id: z.string(),
        event_type: z.string(),
        resource: z
          .object({
            id: z.string().optional(),
            supplementary_data: z
              .object({
                related_ids: z
                  .object({ capture_id: z.string().optional() })
                  .optional(),
              })
              .optional(),
            links: z
              .array(z.object({ rel: z.string(), href: z.string() }))
              .optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(await c.req.json());
    if (
      config.webhookId &&
      !(await service.paypal.verifyWebhook(
        c.req.raw.headers,
        event,
        config.webhookId,
      ))
    )
      return c.json(
        { error: { message: "Invalid PayPal webhook signature" } },
        401,
      );
    if (
      service.store.db
        .prepare("SELECT id FROM webhook_events WHERE id=?")
        .get(event.id)
    )
      return c.json({ duplicate: true });
    if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      const captureId =
        event.resource.supplementary_data?.related_ids?.capture_id ||
        event.resource.links
          ?.find((link) => link.rel === "up")
          ?.href.match(/captures\/([^/]+)$/)?.[1];
      const order = service.store
        .listOrders()
        .find((order) => order.captureId === captureId);
      if (order) await reconcile(service.store, service.paypal, order.id);
    }
    service.store.db
      .prepare("INSERT OR IGNORE INTO webhook_events(id) VALUES(?)")
      .run(event.id);
    return c.json({
      received: true,
      signatureVerification: config.webhookId
        ? "verified"
        : "skipped (local sandbox)",
    });
  });
  app.all("/api/*", (c) =>
    c.json({ error: { message: "API route not found" } }, 404),
  );
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
  return app;
}

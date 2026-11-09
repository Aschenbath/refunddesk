import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { config } from "./config.js";
import { policies } from "../core/policies.js";
import { DeskError, DeskService } from "./service.js";
import { PayPalError } from "./paypal.js";
import { ledgerRow, reconcile } from "./reconcile.js";
import { factsSchema } from "../core/types.js";
import { redactError } from "./errors.js";
import { createCaseReport } from "./case-report.js";
import {
  ownerConfig,
  hasSession,
  peerIp,
  signIn,
  signOut,
  passwordMatches,
  RateLimits,
  boundedBody,
  BodyLimitError,
  type OwnerConfig,
} from "./auth.js";

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
    intent: z.enum(["refund", "exchange", "question", "other"]).optional(),
    confirmedFacts: factsSchema.optional(),
    duplicateOverride: z.string().min(8).max(1000).nullable().optional(),
    replyDraft: z.string().max(8000).optional(),
    replySent: z.boolean().optional(),
  })
  .strict();

export function createApp(
  service: DeskService,
  options: Partial<OwnerConfig> = {},
) {
  const auth = ownerConfig(options);
  const limits = new RateLimits();
  const app = new Hono<{ Variables: { rawBody: string } }>();
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
            error instanceof SyntaxError ? "Invalid JSON" : redactError(error),
        },
      },
      error instanceof SyntaxError ? 400 : 500,
    );
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    const webhook = c.req.path === "/api/webhooks/paypal";
    const expectedOrigin =
      auth.publicOrigin ||
      (auth.nodeEnv !== "production"
        ? `${new URL(c.req.url).protocol}//${c.req.header("host") || new URL(c.req.url).host}`
        : "");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      !webhook &&
      origin &&
      origin !== expectedOrigin
    )
      return c.json(
        { error: { message: "Cross-origin request rejected" } },
        403,
      );
    const publicRead =
      c.req.method === "GET" &&
      ["/api/health", "/api/policies", "/api/session"].includes(c.req.path);
    const login = c.req.path === "/api/sign-in" && c.req.method === "POST";
    if (!webhook && !publicRead && !login && !hasSession(c, auth))
      return c.json({ error: { message: "Owner sign-in required" } }, 401);
    const action = login
      ? "sign-in"
      : c.req.path === "/api/inbox/import" ||
          (c.req.path === "/api/cases" && c.req.method === "POST")
        ? "import"
        : c.req.path.endsWith("/triage")
          ? "triage"
          : null;
    if (
      action &&
      !limits.allow(
        `${peerIp(c, auth)}:${action}`,
        action === "sign-in" ? 8 : action === "import" ? 20 : 12,
      )
    ) {
      c.header("Retry-After", "60");
      return c.json(
        { error: { message: "Too many requests; try again in a minute" } },
        429,
      );
    }
    if (!["GET", "HEAD"].includes(c.req.method)) {
      try {
        c.set("rawBody", await boundedBody(c.req.raw));
      } catch (error) {
        if (error instanceof BodyLimitError)
          return c.json({ error: { message: error.message } }, 413);
        throw error;
      }
    }
    await next();
  });
  app.get("/api/session", (c) =>
    c.json({
      authenticated: hasSession(c, auth),
      passwordRequired: !!auth.ownerPassword,
    }),
  );
  app.post("/api/sign-in", (c) => {
    const { password } = z
      .object({ password: z.string().max(1000) })
      .strict()
      .parse(JSON.parse(c.get("rawBody")));
    if (!auth.ownerPassword || !passwordMatches(password, auth.ownerPassword))
      return c.json({ error: { message: "Incorrect owner password" } }, 401);
    signIn(c, auth);
    c.header("Cache-Control", "no-store");
    return c.json({ authenticated: true });
  });
  app.post("/api/sign-out", (c) => {
    signOut(c);
    return c.json({ authenticated: false });
  });
  app.get("/api/health", (c) =>
    c.json({ ok: true, aiMode: config.demoMode === "replay" ? "offline" : config.aiMode, environment: "sandbox", demoMode: config.demoMode }),
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
  app.get("/api/cases/:id/report", (c) => c.json(
    createCaseReport(service, c.req.param("id"), config.demoMode === "replay" ? "replay" : "sandbox"),
  ));
  app.post("/api/cases", async (c) =>
    c.json(
      service.createMessage(messageSchema.parse(JSON.parse(c.get("rawBody")))),
      201,
    ),
  );
  app.post("/api/inbox/import", async (c) => {
    const inputs = z
      .array(messageSchema)
      .min(1)
      .max(100)
      .parse(JSON.parse(c.get("rawBody")));
    return c.json(
      service.store.transaction(() =>
        inputs.map((input) => service.createMessage(input)),
      ),
      201,
    );
  });
  app.patch("/api/cases/:id", async (c) =>
    c.json(
      service.edit(
        c.req.param("id"),
        editSchema.parse(JSON.parse(c.get("rawBody"))),
      ),
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
    c.json(
      await service.approve(
        c.req.param("id"),
        z
          .object({
            revision: z.number().int().positive(),
            approvedCents: z.number().int().positive(),
          })
          .strict()
          .parse(JSON.parse(c.get("rawBody"))),
      ),
    ),
  );
  app.post("/api/cases/:id/check-paypal", async (c) =>
    c.json(await service.checkPayPal(c.req.param("id"))),
  );
  app.post("/api/cases/:id/retry-new-id", async (c) =>
    c.json(
      await service.retryWithNewId(
        c.req.param("id"),
        z
          .object({
            confirmed: z.boolean(),
            reason: z.string().min(8).max(1000),
            revision: z.number().int().positive(),
          })
          .strict()
          .parse(JSON.parse(c.get("rawBody"))),
      ),
    ),
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
    if (!config.webhookId && auth.nodeEnv === "production")
      return c.json(
        {
          error: {
            message: "PAYPAL_WEBHOOK_ID is required for production webhooks",
          },
        },
        503,
      );
    const rawBody = c.get("rawBody");
    const untouched: unknown = JSON.parse(rawBody);
    if (!config.webhookId)
      return c.json({
        received: true,
        signatureVerification: "unverified",
        acted: false,
      });
    if (
      !(await service.paypal.verifyWebhook(
        c.req.raw.headers,
        untouched,
        config.webhookId,
        rawBody,
      ))
    )
      return c.json(
        { error: { message: "Invalid PayPal webhook signature" } },
        401,
      );
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
                  .object({
                    capture_id: z.string().optional(),
                    order_id: z.string().optional(),
                  })
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
      .parse(untouched);
    if (
      service.store.db
        .prepare("SELECT id FROM webhook_events WHERE id=?")
        .get(event.id)
    )
      return c.json({ duplicate: true });
    if (
      [
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.REFUND.PENDING",
        "PAYMENT.REFUND.FAILED",
      ].includes(event.event_type)
    ) {
      const captureId =
        event.resource.supplementary_data?.related_ids?.capture_id ||
        event.resource.links
          ?.find((link) => link.rel === "up")
          ?.href.match(/captures\/([^/]+)$/)?.[1];
      const order = service.store
        .listOrders()
        .find(
          (order) =>
            order.captureId === captureId ||
            order.paypalOrderId ===
              event.resource.supplementary_data?.related_ids?.order_id ||
            service.store
              .listRefunds(order.id)
              .some((refund) => refund.id === event.resource.id),
        );
      if (order) await reconcile(service.store, service.paypal, order.id);
    }
    service.store.db
      .prepare("INSERT OR IGNORE INTO webhook_events(id) VALUES(?)")
      .run(event.id);
    return c.json({
      received: true,
      signatureVerification: "verified",
    });
  });
  app.all("/api/*", (c) =>
    c.json({ error: { message: "API route not found" } }, 404),
  );
  if (process.env.NODE_ENV === "development") {
    // `npm run dev` / `npm run demo`: Vite serves the UI on 15481 (vite.config.ts); send stray page visits there.
    app.get("*", (c) => c.redirect(`http://localhost:15481${new URL(c.req.url).pathname}`));
    return app;
  }
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
  return app;
}

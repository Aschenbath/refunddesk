import { config, requireSandboxMode } from "../src/server/config.js";
import { Store } from "../src/server/db.js";
import { PayPalClient } from "../src/server/paypal.js";
import { DeskService } from "../src/server/service.js";
import { seededMessages } from "../src/server/fixtures.js";
import { names, emailFor, seedCatalog, seedTemplates } from "../src/server/seed-book.js";
import { reconcile } from "../src/server/reconcile.js";
import type { DeskCase } from "../src/core/types.js";
import { emptyFacts } from "../src/core/types.js";
import { seedCapture, seedRefund } from "../src/server/seed-operations.js";
import { redactError } from "../src/server/errors.js";

requireSandboxMode("seed");
const store = new Store(config.dbPath);
const paypal = new PayPalClient(
  config.paypalClientId,
  config.paypalClientSecret,
);
const service = new DeskService(store, paypal);
const batch = store.transaction(() => {
  if (process.argv.includes("--reset")) {
    // reset() owns its transaction, so clear the active data here atomically with the new batch.
    store.db.exec(
      "DELETE FROM webhook_events; DELETE FROM attempts; DELETE FROM ledger; DELETE FROM refunds; DELETE FROM cases; DELETE FROM orders; DELETE FROM products; DELETE FROM customers; DELETE FROM policies;",
    );
    return store.seedBatch(true);
  }
  return store.seedBatch();
});
try {
  seedCatalog(store);
  for (const template of seedTemplates(batch.date)) {
    const id = template.id;
    if (store.getOrder(id)) {
      console.log(`${id}: existing capture preserved`);
      continue;
    }
    const cents = template.capturedCents;
    const order = await seedCapture(store, paypal, batch.id, template);
    console.log(
      `${id}: order ${order.paypalOrderId}, capture ${order.captureId}, $${(cents / 100).toFixed(2)}`,
    );
  }
  const partial = store.getOrder("FC-1004")!;
  if (!store.listRefunds(partial.id).length) {
    const refund = await seedRefund(store, paypal, batch.id, partial, 1200);
    console.log(
      `Already-refunded scenario: ${partial.captureId} / refund ${refund.id} / $12.00`,
    );
  }
  for (let index = 0; index < seededMessages.length; index++) {
    const fixture = seededMessages[index];
    const id = `case-seed-${String(index + 1).padStart(2, "0")}`;
    if (store.getCase(id)) continue;
    const order = fixture.order
      ? store.getOrder(`FC-${1000 + fixture.order}`)
      : null;
    const damaged = [
      "damage-all",
      "duplicate",
      "already-refunded",
      "wrong-amount",
      "spanish",
      "ambiguous",
    ].includes(fixture.key);
    const value: DeskCase = {
      id,
      revision: 1,
      sender: fixture.sender === null ? "Sam" : names[fixture.sender],
      email:
        fixture.sender === null
          ? "sam@unknown.example.test"
          : emailFor(fixture.sender),
      subject: fixture.subject,
      message: fixture.message,
      createdAt: new Date(Date.now() - (20 - index) * 3600000).toISOString(),
      status: "new",
      orderId: order?.id || null,
      proposal: null,
      proposedFacts: {
        ...emptyFacts(),
        damagedItems: damaged
          ? order?.lines.map((line) => ({
              item: line.id,
              quantity: line.quantity,
            })) || []
          : [],
        hasDamageEvidence: damaged,
      },
      confirmedFacts: emptyFacts(),
      approvedCents: null,
      replyDraft: "",
      replySent: false,
      fixture: fixture.key,
      manualOrder: false,
      duplicateOverride: null,
      error: null,
    };
    store.saveCase(value);
  }
  for (const value of store
    .listCases()
    .filter((value) => value.status === "new" && value.fixture))
    await service.triageCase(value.id);
  for (const order of store.listOrders()) {
    const row = await reconcile(store, paypal, order.id);
    if (!row.match)
      throw new Error(`${order.id} did not reconcile: ${row.error}`);
  }
  console.log(
    `Seed complete: ${store.listOrders().length} captured orders; ${store.listCases().length} inbox cases; ledger matches PayPal.`,
  );
} catch (error) {
  console.error(
    `Seed failed: ${redactError(error)}. Re-run without --reset to resume the persisted batch.`,
  );
  process.exitCode = 1;
} finally {
  store.close();
}

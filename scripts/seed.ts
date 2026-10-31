import { config } from "../src/server/config.js";
import { Store } from "../src/server/db.js";
import { PayPalClient } from "../src/server/paypal.js";
import { DeskService } from "../src/server/service.js";
import { seededMessages } from "../src/server/fixtures.js";
import { policies } from "../src/core/policies.js";
import { reconcile } from "../src/server/reconcile.js";
import type { DeskCase, Order, OrderLine } from "../src/core/types.js";
import { emptyFacts } from "../src/core/types.js";
import { seedCapture, seedRefund } from "../src/server/seed-operations.js";
import { redactError } from "../src/server/errors.js";

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
const products = [
  ["Pebble Espresso Cup", 1800],
  ["Moss Everyday Mug", 2400],
  ["Cloud Breakfast Bowl", 2800],
  ["Tide Side Plate", 3200],
  ["Fern Windowsill Planter", 3800],
  ["Dune Serving Bowl", 4200],
  ["Glade Pasta Bowl", 4800],
  ["Reed Utensil Pot", 5600],
  ["Stoneware Pitcher", 6400],
  ["Meadow Fruit Bowl", 7800],
  ["Tall Willow Vase", 9600],
  ["Fernleaf Dinner Set", 13200],
] as const;
const names = [
  "Maya Chen",
  "Theo Bennett",
  "Amara Okafor",
  "Luis Romero",
  "Priya Shah",
  "Sofía García",
  "Ben Walsh",
  "Iris Park",
  "Noah Wilson",
  "June Taylor",
  "Evan Brooks",
  "Nina Patel",
  "Ada Morgan",
  "Oliver Reed",
  "Zoe Martin",
];
const emailFor = (index: number) =>
  `${names[index]
    .split(" ")[0]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()}@example.test`;
const dateBefore = (days: number) =>
  new Date(Date.parse(batch.date) - days * 86400000).toISOString().slice(0, 10);
try {
  products.forEach(([title, price], index) =>
    store.db
      .prepare("INSERT OR REPLACE INTO products(id,data) VALUES(?,?)")
      .run(
        `p${index + 1}`,
        JSON.stringify({ id: `p${index + 1}`, title, unitCents: price }),
      ),
  );
  names.forEach((name, index) =>
    store.db
      .prepare("INSERT OR REPLACE INTO customers(id,data) VALUES(?,?)")
      .run(
        `customer-${index + 1}`,
        JSON.stringify({
          id: `customer-${index + 1}`,
          name,
          email: emailFor(index),
        }),
      ),
  );
  policies.forEach((policy) =>
    store.db
      .prepare("INSERT OR REPLACE INTO policies(id,data) VALUES(?,?)")
      .run(policy.id, JSON.stringify(policy)),
  );
  for (let index = 1; index <= 25; index++) {
    const id = `FC-${1000 + index}`;
    if (store.getOrder(id)) {
      console.log(`${id}: existing capture preserved`);
      continue;
    }
    const owner = index === 21 ? 10 : (index - 1) % 15;
    let picks: [number, number][] = [[(index - 1) % 10, 1]];
    if (index === 1) picks = [[1, 2]];
    if (index === 2) picks = [[2, 1]];
    if (index === 3 || index === 10) picks = [[4, 1]];
    if (index === 4) picks = [[6, 1]];
    if (index === 5) picks = [[3, 2]];
    if ([6, 11, 21].includes(index)) picks = [[1, 1]];
    if (index === 7)
      picks = [
        [1, 1],
        [4, 1],
      ];
    const lines: OrderLine[] = picks.map(([product, quantity], line) => ({
      id: `${id}-L${line + 1}`,
      productId: `p${product + 1}`,
      title: products[product][0],
      quantity,
      unitCents: products[product][1],
      sale: index === 9,
      returnReceived: [3, 8, 9].includes(index),
    }));
    const cents =
      lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) +
      800;
    const template: Order = {
      id,
      customerId: `customer-${owner + 1}`,
      customerName: names[owner],
      email: emailFor(owner),
      paypalOrderId: "",
      captureId: "",
      currency: "USD",
      capturedCents: cents,
      shippingCents: 800,
      orderedAt: dateBefore(
        index === 8 ? 60 : [2, 7].includes(index) ? 70 : 25,
      ),
      promisedAt: dateBefore(index === 2 ? 21 : index === 7 ? 48 : 17),
      deliveredAt: dateBefore(index === 8 ? 45 : 3),
      lines,
    };
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

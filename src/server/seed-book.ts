import type { Order, OrderLine } from "../core/types.js";
import { policies } from "../core/policies.js";
import type { Store } from "./db.js";

// Shared by the live seed and evaluation. This data is independent of the triage prompt.
export const products = [
  ["Pebble Espresso Cup", 1800], ["Moss Everyday Mug", 2400],
  ["Cloud Breakfast Bowl", 2800], ["Tide Side Plate", 3200],
  ["Fern Windowsill Planter", 3800], ["Dune Serving Bowl", 4200],
  ["Glade Pasta Bowl", 4800], ["Reed Utensil Pot", 5600],
  ["Stoneware Pitcher", 6400], ["Meadow Fruit Bowl", 7800],
  ["Tall Willow Vase", 9600], ["Fernleaf Dinner Set", 13200],
] as const;
export const names = [
  "Maya Chen", "Theo Bennett", "Amara Okafor", "Luis Romero", "Priya Shah",
  "Sofía García", "Ben Walsh", "Iris Park", "Noah Wilson", "June Taylor",
  "Evan Brooks", "Nina Patel", "Ada Morgan", "Oliver Reed", "Zoe Martin",
];
export const emailFor = (index: number) =>
  `${names[index].split(" ")[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()}@example.test`;
export const EVAL_DATE = "2026-10-31";
export function seedTemplates(date: string): Order[] {
  const dateBefore = (days: number) =>
    new Date(Date.parse(date) - days * 86400000).toISOString().slice(0, 10);
  return Array.from({ length: 25 }, (_, offset) => {
    const index = offset + 1, id = `FC-${1000 + index}`;
    const owner = index === 21 ? 10 : (index - 1) % 15;
    let picks: [number, number][] = [[(index - 1) % 10, 1]];
    if (index === 1) picks = [[1, 2]];
    if (index === 2) picks = [[2, 1]];
    if (index === 3 || index === 10) picks = [[4, 1]];
    if (index === 4) picks = [[6, 1]];
    if (index === 5) picks = [[3, 2]];
    if ([6, 11, 21].includes(index)) picks = [[1, 1]];
    if (index === 7) picks = [[1, 1], [4, 1]];
    const lines: OrderLine[] = picks.map(([product, quantity], line) => ({
      id: `${id}-L${line + 1}`, productId: `p${product + 1}`,
      title: products[product][0], quantity, unitCents: products[product][1],
      sale: index === 9, returnReceived: [3, 8, 9].includes(index),
    }));
    return {
      id, customerId: `customer-${owner + 1}`, customerName: names[owner], email: emailFor(owner),
      paypalOrderId: "", captureId: "", currency: "USD",
      capturedCents: lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) + 800,
      shippingCents: 800,
      orderedAt: dateBefore(index === 8 ? 60 : [2, 7].includes(index) ? 70 : 25),
      promisedAt: dateBefore(index === 2 ? 21 : index === 7 ? 48 : 17),
      deliveredAt: dateBefore(index === 8 ? 45 : 3), lines,
    };
  });
}
export function seedCatalog(store: Store) {
  for (const [offset, [title, unitCents]] of products.entries()) {
    const id = `p${offset + 1}`;
    store.db.prepare("INSERT OR REPLACE INTO products(id,data) VALUES(?,?)")
      .run(id, JSON.stringify({ id, title, unitCents }));
  }
  names.forEach((name, index) => {
    const id = `customer-${index + 1}`;
    store.db.prepare("INSERT OR REPLACE INTO customers(id,data) VALUES(?,?)")
      .run(id, JSON.stringify({ id, name, email: emailFor(index) }));
  });
  for (const policy of policies)
    store.db.prepare("INSERT OR REPLACE INTO policies(id,data) VALUES(?,?)")
      .run(policy.id, JSON.stringify(policy));
}
export function seedEvalBook(store: Store) {
  seedCatalog(store);
  for (const order of seedTemplates(EVAL_DATE))
    store.saveOrder({ ...order, paypalOrderId: `eval-order-${order.id}`, captureId: `eval-capture-${order.id}` });
  store.saveRefund({
    id: "eval-prior-FC-1004", caseId: null, orderId: "FC-1004", amountCents: 1200,
    currency: "USD", status: "COMPLETED", requestId: "eval-prior-FC-1004",
    allocations: [{ item: "FC-1004-L1", cents: 1200 }], createdAt: `${EVAL_DATE}T00:00:00Z`,
  });
}

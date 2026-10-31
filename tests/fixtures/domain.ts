import {
  emptyFacts,
  type GuardContext,
  type Order,
  type Proposal,
} from "../../src/core/types.js";
export const order: Order = {
  id: "FC-1001",
  customerId: "c1",
  customerName: "Maya Chen",
  email: "maya@example.test",
  paypalOrderId: "ORDER",
  captureId: "CAPTURE",
  currency: "USD",
  capturedCents: 5600,
  shippingCents: 800,
  orderedAt: "2026-09-01",
  promisedAt: "2026-09-02",
  deliveredAt: "2026-10-02",
  lines: [
    {
      id: "mug",
      productId: "p1",
      title: "Mug",
      quantity: 2,
      unitCents: 2400,
      sale: false,
      returnReceived: true,
    },
  ],
};
export const proposal: Proposal = {
  matched_order_id: order.id,
  match_evidence: ["FC-1001"],
  intent: "refund",
  policy_clause_ids: ["P1.1", "P1.2"],
  proposed_lines: [
    { item: "mug", reason: "Cracked", amount: 4800 },
    { item: "shipping", reason: "All damaged", amount: 800 },
  ],
  proposed_total: 5600,
  currency: "USD",
  customer_reply_draft: "We can refund this.",
  confidence: 0.95,
  needs_human_reason: null,
};
export const context: GuardContext = {
  order,
  proposal,
  facts: {
    ...emptyFacts(),
    damagedItems: [{ item: "mug", quantity: 2 }],
    hasDamageEvidence: true,
    returnedItems: [{ item: "mug", quantity: 2 }],
    returnReceived: true,
    deliveryDates: {
      promisedAt: order.promisedAt,
      deliveredAt: order.deliveredAt,
    },
  },
  now: "2026-10-20",
  refundedCents: 0,
  refundedByLine: {},
  duplicate: false,
  ambiguous: false,
};

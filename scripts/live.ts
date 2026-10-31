import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../src/server/config.js";
import { Store } from "../src/server/db.js";
import { PayPalClient, requestId } from "../src/server/paypal.js";
import { DeskService } from "../src/server/service.js";
import { createApp } from "../src/server/app.js";
import { reconcile } from "../src/server/reconcile.js";
import type { DeskCase, Order } from "../src/core/types.js";

const store = new Store(config.dbPath);
const paypal = new PayPalClient(
  config.paypalClientId,
  config.paypalClientSecret,
);
const service = new DeskService(store, paypal);
const suffix = randomUUID().slice(0, 8);
const orderId = `LIVE-${suffix}`;
const caseId = `case-live-${suffix}`;
try {
  const { order: remote, capture } = await paypal.createAndCapture(
    100,
    orderId,
    requestId(`capture-${suffix}`),
  );
  const today = new Date().toISOString().slice(0, 10);
  const order: Order = {
    id: orderId,
    customerId: "live-test",
    customerName: "Live Sandbox Check",
    email: "live@example.test",
    paypalOrderId: remote.id,
    captureId: capture.id,
    currency: "USD",
    capturedCents: 100,
    shippingCents: 0,
    orderedAt: today,
    promisedAt: today,
    deliveredAt: today,
    lines: [
      {
        id: `${orderId}-L1`,
        title: "Sandbox check",
        productId: "test",
        quantity: 1,
        unitCents: 100,
        sale: false,
        returnReceived: false,
      },
    ],
  };
  store.saveOrder(order);
  const value: DeskCase = {
    id: caseId,
    sender: order.customerName,
    email: order.email,
    subject: "Live approval-path check",
    message: `${orderId}: the handle is cracked. Please refund $0.40.`,
    createdAt: new Date().toISOString(),
    status: "ready",
    orderId,
    manualOrder: true,
    fixture: null,
    approvedCents: 40,
    replyDraft: "Sandbox check only.",
    replySent: false,
    error: null,
    duplicateOverride: null,
    facts: { damagedLineIds: [order.lines[0].id], hasDamageEvidence: true },
    proposal: {
      matched_order_id: orderId,
      match_evidence: [orderId],
      intent: "refund",
      policy_clause_ids: ["P1.1"],
      proposed_lines: [
        { item: order.lines[0].id, amount: 40, reason: "Cracked handle" },
      ],
      proposed_total: 40,
      currency: "USD",
      customer_reply_draft: "Sandbox check only.",
      confidence: 1,
      needs_human_reason: null,
    },
  };
  store.saveCase(value);
  const app = createApp(service);
  const response = await app.request(`/api/cases/${caseId}/approve`, {
    method: "POST",
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ledger.refundedCents, 40);
  assert.equal(result.ledger.match, true);
  assert.equal(result.ledger.paypalStatus, "PARTIALLY_REFUNDED");
  const second = await app.request(`/api/cases/${caseId}/approve`, {
    method: "POST",
  });
  assert.equal(second.status, 409);
  const retried = await paypal.refund(
    capture.id,
    40,
    "USD",
    store.getAttempt(caseId)!.requestId,
  );
  assert.equal(retried.id, result.refund.id);
  const row = await reconcile(store, paypal, orderId);
  assert.equal(row.remoteRefundedCents, 40);
  assert.equal(row.match, true);
  console.log(
    JSON.stringify(
      {
        passed: true,
        captureId: capture.id,
        refundId: result.refund.id,
        captured: "1.00",
        refunded: "0.40",
        paypalStatus: row.paypalStatus,
        ledgerMatch: row.match,
        secondApprovalStatus: second.status,
        retriedRefundId: retried.id,
        idempotent: retried.id === result.refund.id,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}

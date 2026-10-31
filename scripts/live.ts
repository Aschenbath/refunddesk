import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { config, requireSandboxMode } from "../src/server/config.js";
import { Store } from "../src/server/db.js";
import {
  PayPalClient,
  requestId,
  type PayPalRefund,
} from "../src/server/paypal.js";
import { DeskService } from "../src/server/service.js";
import { createApp } from "../src/server/app.js";
import { reconcile } from "../src/server/reconcile.js";
import { emptyFacts, type DeskCase, type Order } from "../src/core/types.js";
import { redactError } from "../src/server/errors.js";

requireSandboxMode("live");
const store = new Store(config.dbPath);
const paypal = new PayPalClient(
  config.paypalClientId,
  config.paypalClientSecret,
);
const service = new DeskService(store, paypal);
const suffix = randomUUID().slice(0, 8);
const orderId = `LIVE-${suffix}`;
const caseId = `case-live-${suffix}`;
if (!config.ownerPassword)
  throw new Error(
    "Set OWNER_PASSWORD in the shell to run the authenticated live check.",
  );
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
    revision: 1,
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
    proposedFacts: {
      ...emptyFacts(),
      damagedItems: [{ item: order.lines[0].id, quantity: 1 }],
      hasDamageEvidence: true,
    },
    confirmedFacts: {
      ...emptyFacts(),
      damagedItems: [{ item: order.lines[0].id, quantity: 1 }],
      hasDamageEvidence: true,
    },
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
  const signedIn = await app.request("/api/sign-in", {
    method: "POST",
    body: JSON.stringify({ password: config.ownerPassword }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
  const approval = () => {
    const value = service.detail(caseId);
    return JSON.stringify({
      revision: value.revision,
      approvedCents: value.check!.approvedCents,
    });
  };
  const unauthorized = await app.request(`/api/cases/${caseId}/approve`, {
    method: "POST",
    body: approval(),
  });
  assert.equal(unauthorized.status, 401);
  const stale = await app.request(`/api/cases/${caseId}/approve`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ revision: 999, approvedCents: 40 }),
  });
  assert.equal(stale.status, 409);
  const response = await app.request(`/api/cases/${caseId}/approve`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: approval(),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ledger.refundedCents, 40);
  assert.equal(result.ledger.match, true);
  assert.equal(result.ledger.paypalStatus, "PARTIALLY_REFUNDED");
  const second = await app.request(`/api/cases/${caseId}/approve`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: approval(),
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
  // Inject a transport failure only after PayPal has actually created the second, ten-cent refund.
  const recoveryId = `${caseId}-recovery`;
  store.saveCase({
    ...value,
    id: recoveryId,
    revision: 1,
    approvedCents: 10,
    duplicateOverride: "Separate explicit sandbox recovery check",
    createdAt: new Date().toISOString(),
  });
  let calls = 0;
  class LostResponseClient extends PayPalClient {
    async refund(
      captureId: string,
      cents: number,
      currency: string,
      key: string,
      attemptId = key,
    ): Promise<PayPalRefund> {
      calls++;
      await super.refund(captureId, cents, currency, key, attemptId);
      throw new Error("Simulated lost response after creation");
    }
  }
  const recoveryService = new DeskService(
    store,
    new LostResponseClient(config.paypalClientId, config.paypalClientSecret),
  );
  const recoveryApp = createApp(recoveryService);
  const recoverValue = recoveryService.detail(recoveryId);
  const lost = await recoveryApp.request(`/api/cases/${recoveryId}/approve`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      revision: recoverValue.revision,
      approvedCents: 10,
    }),
  });
  assert.equal(lost.status, 500);
  const attempt = store.getAttempt(recoveryId)!;
  attempt.createdAt = new Date(Date.now() - 2 * 3600000).toISOString();
  store.saveAttempt(attempt);
  const recoveredResponse = await recoveryApp.request(
    `/api/cases/${recoveryId}/check-paypal`,
    { method: "POST", headers: { Cookie: cookie } },
  );
  const recovered = await recoveredResponse.json();
  assert.equal(recoveredResponse.status, 200, JSON.stringify(recovered));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.ledger.match, true);
  assert.equal(recovered.case.status, "refunded");
  assert.equal(calls, 1);
  const finalRow = await reconcile(store, paypal, orderId);
  assert.equal(finalRow.refundedCents, 50);
  assert.equal(finalRow.remoteRefundedCents, 50);
  assert.equal(store.listRefunds(orderId).length, 2);
  const report = {
    passed: true,
    orderId,
    paypalOrderId: remote.id,
    captureId: capture.id,
    refundId: result.refund.id,
    captured: "1.00",
    refunded: "0.40",
    paypalStatus: row.paypalStatus,
    ledgerMatch: row.match,
    secondApprovalStatus: second.status,
    retriedRefundId: retried.id,
    idempotent: retried.id === result.refund.id,
    unauthorizedStatus: unauthorized.status,
    staleRevisionStatus: stale.status,
    lostResponseRecovery: {
      passed: true,
      refundId: recovered.case.refunds.find(
        (refund: { caseId: string }) => refund.caseId === recoveryId,
      ).id,
      refundCalls: calls,
      ledgerMatch: finalRow.match,
    },
  };
  mkdirSync("output", { recursive: true });
  writeFileSync("output/live-check.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Live check failed: ${redactError(error)}`);
  process.exitCode = 1;
} finally {
  store.close();
}

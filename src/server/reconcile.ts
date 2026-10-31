import { decimalToCents } from "../core/money.js";
import type { LedgerRow } from "../core/types.js";
import type { Store } from "./db.js";
import type { PayPalClient } from "./paypal.js";

export function ledgerRow(store: Store, id: string): LedgerRow {
  const order = store.getOrder(id);
  if (!order) throw new Error("Order not found");
  const previous = store.getLedger(id);
  const refunds = store
    .listRefunds(id)
    .filter((refund) => ["COMPLETED", "PENDING"].includes(refund.status));
  const refunded = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  return {
    orderId: id,
    customer: order.customerName,
    captureId: order.captureId,
    currency: order.currency,
    capturedCents: order.capturedCents,
    refundedCents: refunded,
    netCents: order.capturedCents - refunded,
    paypalStatus: previous?.paypalStatus || "NOT_CHECKED",
    remoteCapturedCents: previous?.remoteCapturedCents ?? null,
    remoteRefundedCents: previous?.remoteRefundedCents ?? null,
    match: previous?.match ?? null,
    checkedAt: previous?.checkedAt || null,
    error: previous?.error || null,
    refundIds: refunds.map((refund) => refund.id),
  };
}
export async function reconcile(
  store: Store,
  paypal: PayPalClient,
  id: string,
): Promise<LedgerRow> {
  const order = store.getOrder(id);
  if (!order) throw new Error("Order not found");
  try {
    const [capture, remoteOrder] = await Promise.all([
      paypal.getCapture(order.captureId),
      paypal.getOrder(order.paypalOrderId),
    ]);
    const remoteRefunds =
      remoteOrder.purchase_units?.flatMap(
        (unit) => unit.payments?.refunds || [],
      ) || [];
    // Order details enumerate refund ids. Read each refund independently, not just our local receipts.
    const ids = [
      ...new Set([
        ...remoteRefunds.map((refund) => refund.id),
        ...store.listRefunds(id).map((refund) => refund.id),
      ]),
    ];
    const receipts = await Promise.all(
      ids.map((refundId) => paypal.getRefund(refundId)),
    );
    for (const receipt of receipts) {
      const local = store
        .listRefunds(id)
        .find((refund) => refund.id === receipt.id);
      if (local) store.saveRefund({ ...local, status: receipt.status });
    }
    const known = new Set(store.listRefunds(id).map((refund) => refund.id));
    const remoteCents = receipts
      .filter((refund) => ["COMPLETED", "PENDING"].includes(refund.status))
      .reduce((sum, refund) => sum + decimalToCents(refund.amount.value), 0);
    const row = ledgerRow(store, id);
    const statusMatches =
      capture.status === "COMPLETED"
        ? remoteCents === 0
        : capture.status === "PARTIALLY_REFUNDED"
          ? remoteCents > 0 && remoteCents < row.capturedCents
          : capture.status === "REFUNDED"
            ? remoteCents === row.capturedCents
            : false;
    row.remoteCapturedCents = decimalToCents(capture.amount.value);
    row.remoteRefundedCents = remoteCents;
    row.paypalStatus = capture.status;
    row.match =
      capture.id === order.captureId &&
      remoteOrder.id === order.paypalOrderId &&
      row.remoteCapturedCents === row.capturedCents &&
      remoteCents === row.refundedCents &&
      capture.amount.currency_code === order.currency &&
      receipts.every(
        (refund) =>
          refund.amount.currency_code === order.currency &&
          known.has(refund.id),
      ) &&
      statusMatches;
    row.checkedAt = new Date().toISOString();
    row.error = row.match
      ? null
      : "PayPal records differ from the local ledger. Review before another refund.";
    store.saveLedger(row);
    return row;
  } catch (error) {
    const row = ledgerRow(store, id);
    row.match = false;
    row.error =
      error instanceof Error ? error.message : "Reconciliation failed";
    row.checkedAt = new Date().toISOString();
    store.saveLedger(row);
    throw error;
  }
}

import { decimalToCents } from "../core/money.js";
import type { LedgerRow, Order } from "../core/types.js";
import type { Store, Attempt } from "./db.js";
import type { PayPalClient, PayPalRefund } from "./paypal.js";
import { redactError } from "./errors.js";

export function ledgerRow(store: Store, id: string): LedgerRow {
  const order = store.getOrder(id);
  if (!order) throw new Error("Order not found");
  const previous = store.getLedger(id);
  const refunds = store.listRefunds(id);
  const refunded = refunds
    .filter((refund) => refund.status === "COMPLETED")
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  const pending = refunds
    .filter((refund) => refund.status === "PENDING")
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  return {
    orderId: id,
    customer: order.customerName,
    captureId: order.captureId,
    currency: order.currency,
    capturedCents: order.capturedCents,
    refundedCents: refunded,
    pendingCents: pending,
    netCents: order.capturedCents - refunded,
    paypalStatus: pending
      ? "REFUND_PENDING"
      : previous?.paypalStatus || "NOT_CHECKED",
    remoteCapturedCents: previous?.remoteCapturedCents ?? null,
    remoteRefundedCents: previous?.remoteRefundedCents ?? null,
    match: previous?.match ?? null,
    checkedAt: previous?.checkedAt || null,
    error: previous?.error || null,
    refundIds: refunds.map((refund) => refund.id),
    unexpectedRefundIds: previous?.unexpectedRefundIds || [],
  };
}

export function receiptMatches(
  receipt: PayPalRefund,
  cents: number,
  currency: string,
): boolean {
  return (
    receipt.amount.currency_code === currency &&
    decimalToCents(receipt.amount.value) === cents &&
    ["COMPLETED", "PENDING", "FAILED", "CANCELLED"].includes(receipt.status)
  );
}

export async function readCaptureRefunds(paypal: PayPalClient, order: Order) {
  const [capture, remoteOrder] = await Promise.all([
    paypal.getCapture(order.captureId),
    paypal.getOrder(order.paypalOrderId),
  ]);
  const units = remoteOrder.purchase_units || [];
  const captureUnits = units.filter((unit) =>
    unit.payments?.captures?.some((item) => item.id === order.captureId),
  );
  const belongs =
    capture.id === order.captureId &&
    remoteOrder.id === order.paypalOrderId &&
    (capture.supplementary_data?.related_ids?.order_id ===
      order.paypalOrderId ||
      captureUnits.length > 0);
  if (!belongs) throw new Error("Capture does not belong to this PayPal order");
  const listed = (captureUnits.length ? captureUnits : units).flatMap(
    (unit) => unit.payments?.refunds || [],
  );
  const ids = [...new Set(listed.map((item) => item.id))];
  const receipts = await Promise.all(
    ids.map(async (id) => {
      const receipt = await paypal.getRefund(id);
      if (receipt.id !== id) throw new Error("PayPal refund identity mismatch");
      const related =
        receipt.supplementary_data?.related_ids?.capture_id ||
        receipt.links
          ?.find((link) => link.rel === "up")
          ?.href.match(/captures\/([^/]+)\/?$/)?.[1];
      const unitAssociation = captureUnits.some(
        (unit) =>
          unit.payments?.captures?.length === 1 &&
          unit.payments.refunds?.some((item) => item.id === id),
      );
      if (related ? related !== order.captureId : !unitAssociation)
        throw new Error("PayPal refund capture association mismatch");
      return receipt;
    }),
  );
  return { capture, receipts };
}

export function importAttemptReceipt(
  store: Store,
  attempt: Attempt,
  receipt: PayPalRefund,
) {
  if (!receiptMatches(receipt, attempt.amountCents, attempt.currency))
    throw new Error("Refund receipt differs from the frozen approval snapshot");
  const owner = store.listRefunds().find((refund) => refund.id === receipt.id);
  if (owner && owner.caseId !== attempt.caseId)
    throw new Error("Refund receipt is already assigned to another case");
  store.saveRefund({
    id: receipt.id,
    caseId: attempt.caseId,
    orderId: attempt.orderId,
    amountCents: attempt.amountCents,
    currency: attempt.currency,
    status: receipt.status,
    requestId: attempt.requestId,
    allocations: attempt.allocations,
    createdAt: attempt.createdAt,
    returnFeeCaseId: attempt.returnFeeCaseId,
    returnedItems: attempt.returnFeeCaseId
      ? attempt.snapshot.facts.returnedItems
      : [],
  });
  attempt.refundId = receipt.id;
  attempt.state =
    receipt.status === "COMPLETED"
      ? "completed"
      : receipt.status === "PENDING"
        ? "pending"
        : "failed";
  attempt.remoteAbsent = false;
  store.saveAttempt(attempt);
  const value = store.getCase(attempt.caseId);
  if (value) {
    value.status =
      attempt.state === "completed"
        ? "refunded"
        : attempt.state === "pending"
          ? "pending"
          : "needs_human";
    value.error =
      attempt.state === "failed"
        ? `PayPal refund ${receipt.status.toLowerCase()}. Review the failure before any further action.`
        : null;
    store.saveCase(value);
  }
}

export async function reconcile(
  store: Store,
  paypal: PayPalClient,
  id: string,
): Promise<LedgerRow> {
  const order = store.getOrder(id);
  if (!order) throw new Error("Order not found");
  try {
    const { capture, receipts } = await readCaptureRefunds(paypal, order);
    return store.transaction(() => {
      const local = store.listRefunds(id);
      const unexpected = receipts
        .filter((receipt) => !local.some((refund) => refund.id === receipt.id))
        .map((receipt) => receipt.id);
      const missing = local.some(
        (refund) => !receipts.some((receipt) => receipt.id === refund.id),
      );
      let exact = !missing && !unexpected.length;
      for (const receipt of receipts) {
        const refund = local.find((refund) => refund.id === receipt.id);
        if (!refund) continue;
        if (!receiptMatches(receipt, refund.amountCents, refund.currency)) {
          exact = false;
          continue;
        }
        const validTransition =
          refund.status === receipt.status || refund.status === "PENDING";
        if (!validTransition) {
          exact = false;
          continue;
        }
        const attempt = refund.caseId ? store.getAttempt(refund.caseId) : null;
        if (attempt) importAttemptReceipt(store, attempt, receipt);
        else store.saveRefund({ ...refund, status: receipt.status });
      }
      const row = ledgerRow(store, id);
      const remoteCompleted = receipts
        .filter((receipt) => receipt.status === "COMPLETED")
        .reduce(
          (sum, receipt) => sum + decimalToCents(receipt.amount.value),
          0,
        );
      const remotePending = receipts
        .filter((receipt) => receipt.status === "PENDING")
        .reduce(
          (sum, receipt) => sum + decimalToCents(receipt.amount.value),
          0,
        );
      const statusMatches =
        capture.status === "COMPLETED"
          ? remoteCompleted === 0
          : capture.status === "PARTIALLY_REFUNDED"
            ? remoteCompleted > 0 && remoteCompleted < order.capturedCents
            : capture.status === "REFUNDED"
              ? remoteCompleted === order.capturedCents
              : false;
      row.remoteCapturedCents = decimalToCents(capture.amount.value);
      row.remoteRefundedCents = remoteCompleted;
      row.paypalStatus = remotePending ? "REFUND_PENDING" : capture.status;
      row.unexpectedRefundIds = unexpected;
      row.match =
        exact &&
        statusMatches &&
        row.remoteCapturedCents === order.capturedCents &&
        capture.amount.currency_code === order.currency &&
        remoteCompleted === row.refundedCents &&
        remotePending === row.pendingCents &&
        receipts.every(
          (receipt) => receipt.amount.currency_code === order.currency,
        );
      row.error = row.match
        ? null
        : unexpected.length
          ? "Unexpected refund: PayPal has a refund with no local record. Check PayPal before another refund."
          : "PayPal records differ from the local ledger. Review before another refund.";
      row.checkedAt = new Date().toISOString();
      store.saveLedger(row);
      return row;
    });
  } catch (error) {
    const row = ledgerRow(store, id);
    row.match = false;
    row.error = redactError(error);
    row.checkedAt = new Date().toISOString();
    store.saveLedger(row);
    throw error;
  }
}

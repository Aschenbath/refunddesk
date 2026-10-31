import type { Order } from "../core/types.js";
import { decimalToCents } from "../core/money.js";
import type { Store, SeedIntent } from "./db.js";
import { PayPalClient, requestId, type PayPalOrder } from "./paypal.js";
import { readCaptureRefunds, receiptMatches } from "./reconcile.js";
import { IDEMPOTENCY_WINDOW_MS } from "./service.js";

function canReuse(intent: SeedIntent) {
  return Date.now() - Date.parse(intent.createdAt) < IDEMPOTENCY_WINDOW_MS;
}
function noResubmit(intent: SeedIntent) {
  throw new Error(
    `Seed ${intent.kind} ${intent.invoiceId} is uncertain beyond the request-id window. Check PayPal reporting; no new payment was sent.`,
  );
}
export async function seedCapture(
  store: Store,
  paypal: PayPalClient,
  batch: string,
  template: Order,
): Promise<Order> {
  const id = `capture:${batch}:${template.id}`;
  let intent = store.getSeedIntent(id);
  const resumed = !!intent;
  if (!intent) {
    intent = {
      id,
      batch,
      kind: "capture",
      requestId: requestId(id),
      invoiceId: `seed-${batch}-${template.id}`,
      amountCents: template.capturedCents,
      createdAt: new Date().toISOString(),
      state: "intent",
      order: template,
    };
    store.saveSeedIntent(intent);
  }
  // All immutable order dates, quantities and amounts come from the persisted intent.
  template = intent.order!;
  let remote: PayPalOrder | null = null;
  if (intent.paypalOrderId)
    remote = await paypal.getOrder(intent.paypalOrderId);
  let capture = remote?.purchase_units
    ?.flatMap((unit) => unit.payments?.captures || [])
    .find((capture) => capture.status === "COMPLETED");
  if (resumed && !remote) {
    try {
      const found = await paypal.findCaptureByInvoice(
        intent.invoiceId,
        intent.createdAt,
      );
      if (found) {
        remote = found.order;
        capture = found.capture;
      }
    } catch (error) {
      // Reporting permission/lag cannot justify a fresh charge. A retained id can safely be reused.
      if (!canReuse(intent)) throw error;
    }
  }
  if (!capture) {
    if (resumed && !canReuse(intent)) noResubmit(intent);
    intent.state = "uncertain";
    store.saveSeedIntent(intent);
    if (remote) {
      remote = await paypal.captureOrder(remote.id, `${intent.requestId}-cap`);
      capture = remote.purchase_units?.flatMap(
        (unit) => unit.payments?.captures || [],
      )[0];
    } else {
      const result = await paypal.createAndCapture(
        intent.amountCents,
        intent.invoiceId,
        intent.requestId,
        (created) => {
          intent!.paypalOrderId = created.id;
          store.saveSeedIntent(intent!);
        },
      );
      remote = result.order;
      capture = result.capture;
    }
  }
  if (
    !remote ||
    !capture ||
    capture.status !== "COMPLETED" ||
    capture.amount.currency_code !== template.currency ||
    decimalToCents(capture.amount.value) !== intent.amountCents ||
    !remote.purchase_units?.some((unit) =>
      unit.payments?.captures?.some((item) => item.id === capture!.id),
    )
  )
    throw new Error("Seed capture does not match its persisted intent");
  const order = {
    ...template,
    paypalOrderId: remote.id,
    captureId: capture.id,
  };
  store.transaction(() => {
    intent!.state = "done";
    intent!.paypalOrderId = remote.id;
    intent!.captureId = capture.id;
    store.saveSeedIntent(intent!);
    store.saveOrder(order);
  });
  return order;
}

export async function seedRefund(
  store: Store,
  paypal: PayPalClient,
  batch: string,
  order: Order,
  cents: number,
) {
  const id = `refund:${batch}:${order.id}`;
  let intent = store.getSeedIntent(id);
  const resumed = !!intent;
  if (!intent) {
    intent = {
      id,
      batch,
      kind: "refund",
      requestId: requestId(id),
      invoiceId: requestId(id),
      amountCents: cents,
      createdAt: new Date().toISOString(),
      state: "intent",
      paypalOrderId: order.paypalOrderId,
      captureId: order.captureId,
    };
    store.saveSeedIntent(intent);
  }
  const { receipts } = await readCaptureRefunds(paypal, order);
  const matches = receipts.filter(
    (receipt) =>
      receipt.invoice_id === intent!.invoiceId ||
      receipt.custom_id === intent!.invoiceId ||
      receipt.id === intent!.refundId,
  );
  if (matches.length > 1)
    throw new Error("Multiple refunds match the seed intent");
  let receipt = matches[0];
  if (!receipt) {
    if (resumed && !canReuse(intent)) noResubmit(intent);
    intent.state = "uncertain";
    store.saveSeedIntent(intent);
    receipt = await paypal.refund(
      order.captureId,
      intent.amountCents,
      order.currency,
      intent.requestId,
      intent.invoiceId,
    );
  }
  if (!receiptMatches(receipt, intent.amountCents, order.currency))
    throw new Error("Seed refund differs from its persisted intent");
  store.transaction(() => {
    store.saveRefund({
      id: receipt.id,
      caseId: null,
      orderId: order.id,
      amountCents: intent!.amountCents,
      currency: order.currency,
      status: receipt.status,
      requestId: intent!.requestId,
      allocations: [{ item: order.lines[0].id, cents: intent!.amountCents }],
      createdAt: intent!.createdAt,
    });
    intent!.state = "done";
    intent!.refundId = receipt.id;
    store.saveSeedIntent(intent!);
  });
  return receipt;
}

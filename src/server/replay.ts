import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PayPalClient, type PayPalCapture, type PayPalOrder, type PayPalRefund } from "./paypal.js";
import { centsToDecimal, decimalToCents } from "../core/money.js";
import type { DeskCase, LedgerRow, Order, Refund } from "../core/types.js";
import type { Store } from "./db.js";
import { seedCatalog } from "./seed-book.js";

export interface DemoSnapshot {
  version: 1; referenceDate: string; provenance: string;
  orders: Order[]; cases: DeskCase[]; refunds: Refund[]; ledger: LedgerRow[];
  recorded: { captures: PayPalCapture[]; orders: PayPalOrder[]; refunds: PayPalRefund[] };
}
export function loadSnapshot(): DemoSnapshot {
  return parseSnapshot(readFileSync("demo/snapshot.json", "utf8"));
}
/** Replay must never fall back to the real client, so a malformed snapshot stops startup. */
export function parseSnapshot(text: string): DemoSnapshot {
  const value = JSON.parse(text) as DemoSnapshot | null;
  const lists = value && [value.orders, value.cases, value.refunds, value.ledger, value.recorded?.captures, value.recorded?.orders, value.recorded?.refunds];
  if (!value || value.version !== 1 || typeof value.referenceDate !== "string" || !lists!.every(Array.isArray))
    throw new Error("demo/snapshot.json is not a valid version 1 replay snapshot.");
  return value;
}
export function hydrateReplay(store: Store, snapshot: DemoSnapshot) {
  const shift = Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(snapshot.referenceDate);
  const date = (value: string) => new Date(Date.parse(value) + shift).toISOString().slice(0, value.length === 10 ? 10 : 24);
  seedCatalog(store);
  for (const order of snapshot.orders) store.saveOrder({ ...order, orderedAt: date(order.orderedAt), promisedAt: date(order.promisedAt), deliveredAt: date(order.deliveredAt) });
  for (const refund of snapshot.refunds) store.saveRefund({ ...refund, createdAt: date(refund.createdAt) });
  for (const row of snapshot.ledger) store.saveLedger({ ...row, checkedAt: row.checkedAt ? date(row.checkedAt) : null });
  for (const value of snapshot.cases) {
    const next = structuredClone(value);
    next.createdAt = date(next.createdAt);
    for (const facts of [next.proposedFacts, next.confirmedFacts]) if (facts.deliveryDates)
      facts.deliveryDates = { promisedAt: date(facts.deliveryDates.promisedAt), deliveredAt: date(facts.deliveryDates.deliveredAt) };
    store.saveCase(next);
  }
}
// Payment adapter with no network route. Recorded receipts retain real sandbox IDs;
// new refunds are deterministic simulations, including request-id deduplication.
export class ReplayPayPalClient extends PayPalClient {
  private store: Store;
  private snapshot: DemoSnapshot;
  private simulated = new Map<string, PayPalRefund>();
  constructor(store: Store, snapshot: DemoSnapshot) {
    super("", "", async () => { throw new Error("Replay client has no network access"); });
    this.store = store;
    this.snapshot = snapshot;
  }
  private receipts(captureId: string) {
    const order = this.store.listOrders().find((order) => order.captureId === captureId);
    if (!order) throw new Error("Unknown replay capture");
    const recordedOrder = this.snapshot.recorded.orders.find((remote) => remote.id === order.paypalOrderId);
    const ids = new Set(recordedOrder?.purchase_units?.flatMap((unit) => unit.payments?.refunds?.map((receipt) => receipt.id) || []));
    const receipts = this.snapshot.recorded.refunds.filter((receipt) => ids.has(receipt.id));
    const simulated = [...this.simulated.values()].filter((receipt) => receipt.supplementary_data?.related_ids?.capture_id === captureId);
    return [...receipts, ...simulated];
  }
  override async getCapture(id: string): Promise<PayPalCapture> {
    const capture = this.snapshot.recorded.captures.find((capture) => capture.id === id);
    if (!capture) throw new Error("Unknown replay capture");
    const refunded = this.receipts(id).filter((receipt) => receipt.status === "COMPLETED").reduce((sum, receipt) => sum + decimalToCents(receipt.amount.value), 0);
    return { ...structuredClone(capture), status: refunded >= decimalToCents(capture.amount.value) ? "REFUNDED" : refunded ? "PARTIALLY_REFUNDED" : "COMPLETED" };
  }
  override async getOrder(id: string): Promise<PayPalOrder> {
    const recorded = this.snapshot.recorded.orders.find((order) => order.id === id);
    const local = this.store.listOrders().find((order) => order.paypalOrderId === id);
    if (!recorded || !local) throw new Error("Unknown replay order");
    return { ...structuredClone(recorded), purchase_units: [{ payments: { captures: [await this.getCapture(local.captureId)], refunds: this.receipts(local.captureId) } }] };
  }
  override async getRefund(id: string): Promise<PayPalRefund> {
    const receipt = this.simulated.get(id) || this.snapshot.recorded.refunds.find((receipt) => receipt.id === id);
    if (!receipt) throw new Error("Unknown replay refund");
    return structuredClone(receipt);
  }
  override async refund(captureId: string, cents: number, currency: string, key: string, attemptId = key): Promise<PayPalRefund> {
    const id = `REPLAY-${createHash("sha256").update(`${captureId}:${key}`).digest("hex").slice(0, 16)}`;
    if (this.simulated.has(id)) {
      const previous = this.simulated.get(id)!;
      if (decimalToCents(previous.amount.value) !== cents || previous.amount.currency_code !== currency)
        throw new Error("Replay idempotency key used with different amount");
      return structuredClone(previous);
    }
    const capture = await this.getCapture(captureId);
    const refunded = this.receipts(captureId).reduce((sum, receipt) => sum + decimalToCents(receipt.amount.value), 0);
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents + refunded > decimalToCents(capture.amount.value) || currency !== capture.amount.currency_code)
      throw new Error("Replay refund exceeds the captured balance");
    const receipt: PayPalRefund = { id, status: "COMPLETED", amount: { currency_code: currency, value: centsToDecimal(cents) }, invoice_id: attemptId, custom_id: attemptId, supplementary_data: { related_ids: { capture_id: captureId } } };
    this.simulated.set(id, receipt);
    return structuredClone(receipt);
  }
  override async verifyWebhook(): Promise<boolean> { return false; }
  override async createAndCapture(): Promise<never> { throw new Error("Captures are unavailable in replay mode"); }
  override async captureOrder(): Promise<never> { throw new Error("Captures are unavailable in replay mode"); }
  override async findCaptureByInvoice(): Promise<never> { throw new Error("Reporting is unavailable in replay mode"); }
}

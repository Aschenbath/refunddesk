import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/server/db.js";
import { loadSnapshot, hydrateReplay, parseSnapshot, ReplayPayPalClient } from "../src/server/replay.js";
import { reconcile } from "../src/server/reconcile.js";
import { DeskService } from "../src/server/service.js";
import { emptyFacts } from "../src/core/types.js";
describe("zero-key replay", () => {
  it("reconciles recorded receipts, simulates bounded refunds and deduplicates requests without network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    const store = new Store(":memory:"), snapshot = loadSnapshot(); hydrateReplay(store, snapshot);
    const paypal = new ReplayPayPalClient(store, snapshot), service = new DeskService(store, paypal, { aiMode: "offline" });
    try {
      for (const order of store.listOrders()) expect((await reconcile(store, paypal, order.id)).match).toBe(true);
      const order = store.getOrder("FC-1005")!;
      const input = service.createMessage({ sender: order.customerName, email: order.email, subject: "Separate reviewed replay refund", message: `${order.id}: one plate has a cracked handle. Refund please.` });
      service.edit(input.id, { orderId: order.id, intent: "refund", clauseIds: ["P1.1"], duplicateOverride: "Separate explicitly reviewed replay scenario", confirmedFacts: { ...emptyFacts(), hasDamageEvidence: true, damagedItems: [{ item: order.lines[0].id, quantity: 1 }] } });
      const value = service.detail(input.id);
      expect(value.check?.computedCents).toBe(3200);
      const result = await service.approve(input.id, { revision: value.revision, approvedCents: value.check!.approvedCents });
      expect(result.refund.id).toMatch(/^REPLAY-/);
      expect(result.ledger.match).toBe(true); expect(result.ledger.refundedCents).toBe(3200);
      const attempt = store.getAttempt(input.id)!;
      expect((await paypal.refund(order.captureId, 3200, "USD", attempt.requestId, attempt.id)).id).toBe(result.refund.id);
      await expect(paypal.refund(order.captureId, 3201, "USD", attempt.requestId)).rejects.toThrow("different amount");
      await expect(paypal.refund(order.captureId, order.capturedCents, "USD", "too-much")).rejects.toThrow("balance");
      expect(await paypal.verifyWebhook()).toBe(false);
      await expect(paypal.createAndCapture()).rejects.toThrow("unavailable");
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); store.close(); }
  });
});
describe("replay snapshot validation", () => {
  it("refuses snapshots that are null or missing lists instead of falling back to the real client", () => {
    expect(() => parseSnapshot("null")).toThrow(/valid version 1/);
    expect(() => parseSnapshot(JSON.stringify({ version: 1, referenceDate: "2026-10-01", orders: [] }))).toThrow(/valid version 1/);
    expect(loadSnapshot().version).toBe(1);
  });
});

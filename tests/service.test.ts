import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/server/db.js";
import { DeskService } from "../src/server/service.js";
import { createApp } from "../src/server/app.js";
import { PayPalClient } from "../src/server/paypal.js";
import { validatedTriage, readonlyTools } from "../src/server/triage.js";
import { order, proposal, context } from "./fixtures/domain.js";
import type { DeskCase } from "../src/core/types.js";

const stores: Store[] = [];
function reviewed(service: DeskService, id = "case1") {
  const value = service.detail(id);
  return {
    revision: value.revision,
    approvedCents: value.check!.approvedCents,
  };
}
function approvalBody(service: DeskService) {
  return JSON.stringify(reviewed(service));
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  store.saveOrder(order);
  let refunded = false;
  const refund = {
    id: "REFUND",
    status: "COMPLETED",
    amount: { value: "8.00", currency_code: "USD" },
  };
  const paypal = {
    getCapture: vi.fn(async () => ({
      id: "CAPTURE",
      status: refunded ? "PARTIALLY_REFUNDED" : "COMPLETED",
      amount: { value: "56.00", currency_code: "USD" },
    })),
    getOrder: vi.fn(async () => ({
      id: "ORDER",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: store.getOrder(order.id)!.captureId,
                status: "COMPLETED",
                amount: { value: "56.00", currency_code: "USD" },
              },
            ],
            refunds: refunded ? [refund] : [],
          },
        },
      ],
    })),
    getRefund: vi.fn(async () => refund),
    refund: vi.fn(async () => {
      refunded = true;
      return refund;
    }),
  };
  const value: DeskCase = {
    id: "case1",
    revision: 1,
    sender: "Maya Chen",
    email: order.email,
    subject: "Broken mugs",
    message: "FC-1001: both mugs have cracked handles.",
    createdAt: new Date().toISOString(),
    status: "ready",
    orderId: order.id,
    proposal,
    proposedFacts: context.facts,
    confirmedFacts: context.facts,
    approvedCents: 800,
    replyDraft: "",
    replySent: false,
    fixture: null,
    manualOrder: true,
    duplicateOverride: null,
    error: null,
  };
  store.saveCase(value);
  const service = new DeskService(store, paypal as unknown as PayPalClient);
  return {
    store,
    service,
    paypal,
    app: createApp(service, {
      ownerPassword: "",
      nodeEnv: "test",
      publicOrigin: "",
      getIp: () => "127.0.0.1",
    }),
    value,
  };
}
describe("approval API and persistence", () => {
  it("approves, reconciles, and blocks a second approval without a second PayPal call", async () => {
    const { app, paypal, service } = setup();
    const response = await app.request("/api/cases/case1/approve", {
      method: "POST",
      body: approvalBody(service),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ledger).toMatchObject({
      refundedCents: 800,
      match: true,
      paypalStatus: "PARTIALLY_REFUNDED",
    });
    const completed = await (await app.request("/api/cases/case1")).json();
    expect(completed.check).toMatchObject({
      approvedCents: 800,
      computedCents: 5600,
      kind: "adjusted",
    });
    expect(
      (
        await app.request("/api/cases/case1/approve", {
          method: "POST",
          body: approvalBody(service),
        })
      ).status,
    ).toBe(409);
    expect(paypal.refund).toHaveBeenCalledTimes(1);
  });
  it("claims concurrent approvals atomically", async () => {
    const { app, paypal, service } = setup();
    const responses = await Promise.all([
      app.request("/api/cases/case1/approve", {
        method: "POST",
        body: approvalBody(service),
      }),
      app.request("/api/cases/case1/approve", {
        method: "POST",
        body: approvalBody(service),
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(paypal.refund).toHaveBeenCalledTimes(1);
  });
  it("uses different refund keys after a reset reuses a seeded case id for a new capture", async () => {
    const first = setup();
    const second = setup();
    second.store.saveOrder({ ...order, captureId: "NEW-CAPTURE" });
    second.paypal.getCapture.mockImplementation(async () => ({
      id: "NEW-CAPTURE",
      status: second.paypal.refund.mock.calls.length
        ? "PARTIALLY_REFUNDED"
        : "COMPLETED",
      amount: { value: "56.00", currency_code: "USD" },
    }));
    await first.service.approve("case1", reviewed(first.service));
    await second.service.approve("case1", reviewed(second.service));
    expect(first.store.getAttempt("case1")?.requestId).not.toBe(
      second.store.getAttempt("case1")?.requestId,
    );
  });
  it("preserves a reply edited while the refund is in progress", async () => {
    const { service, paypal, store } = setup();
    const original = paypal.refund.getMockImplementation()!;
    paypal.refund.mockImplementationOnce(async () => {
      service.edit("case1", { replyDraft: "Updated by the owner" });
      return original();
    });
    await service.approve("case1", reviewed(service));
    expect(store.getCase("case1")?.replyDraft).toBe("Updated by the owner");
  });
  it("retries an uncertain outcome with the original amount and key and rejects edits", async () => {
    const { app, store, paypal, service } = setup();
    paypal.refund.mockRejectedValueOnce(new Error("Connection lost"));
    expect(
      (
        await app.request("/api/cases/case1/approve", {
          method: "POST",
          body: approvalBody(service),
        })
      ).status,
    ).toBe(500);
    const attempt = store.getAttempt("case1")!;
    expect(attempt.state).toBe("uncertain");
    expect(
      (
        await app.request("/api/cases/case1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvedCents: 1000 }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request("/api/cases/case1/approve", {
          method: "POST",
          body: approvalBody(service),
        })
      ).status,
    ).toBe(200);
    expect(paypal.refund.mock.calls[0]).toEqual(paypal.refund.mock.calls[1]);
    expect(store.getAttempt("case1")?.requestId).toBe(attempt.requestId);
  });
  it("rejects an over-policy edit without changing the saved amount", async () => {
    const { service, store } = setup();
    expect(() => service.edit("case1", { approvedCents: 5601 })).toThrow(
      "Amount exceeds",
    );
    expect(store.getCase("case1")?.approvedCents).toBe(800);
  });
  it("does not approve a different order edited during the remote check", async () => {
    const { service, store, paypal, value } = setup();
    store.saveOrder({ ...order, id: "FC-OTHER" });
    paypal.getCapture.mockImplementationOnce(async () => {
      service.edit(value.id, { orderId: "FC-OTHER" });
      return {
        id: "CAPTURE",
        status: "COMPLETED",
        amount: { value: "56.00", currency_code: "USD" },
      };
    });
    await expect(service.approve(value.id, reviewed(service))).rejects.toThrow(
      "This case changed; review again",
    );
    expect(paypal.refund).not.toHaveBeenCalled();
  });
  it("blocks ambiguous order and lets a human select it", () => {
    const { service, store, value } = setup();
    store.saveCase({
      ...value,
      manualOrder: false,
      email: "wrong@example.test",
      sender: "Unknown",
      message: "My mug is cracked.",
      orderId: order.id,
    });
    expect(service.detail(value.id).check?.kind).toBe("blocked");
    expect(service.edit(value.id, { orderId: order.id }).check?.kind).toBe(
      "pass",
    );
  });
  it("does not let duplicate override bypass an in-flight order lock", async () => {
    const { service, store, value } = setup();
    store.saveAttempt({
      id: "other-key",
      revision: value.revision,
      snapshot: {
        revision: value.revision,
        amountCents: 100,
        allocations: [],
        facts: context.facts,
        clauseIds: ["P1.1"],
        order,
        duplicateOverride: null,
      },
      caseId: "other",
      orderId: order.id,
      requestId: "other-key",
      amountCents: 100,
      currency: "USD",
      allocations: [],
      state: "uncertain",
      createdAt: value.createdAt,
    });
    store.saveCase({
      ...value,
      duplicateOverride: "Confirmed separate item damage",
    });
    await expect(service.approve(value.id, reviewed(service))).rejects.toThrow(
      "processing or unresolved",
    );
  });
  it("fails closed when PayPal reports an unrecognised external refund", async () => {
    const { service, paypal } = setup();
    paypal.getCapture.mockResolvedValueOnce({
      id: "CAPTURE",
      status: "PARTIALLY_REFUNDED",
      amount: { value: "56.00", currency_code: "USD" },
    });
    paypal.getOrder.mockResolvedValueOnce({
      id: "ORDER",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: "CAPTURE",
                status: "COMPLETED",
                amount: { value: "56.00", currency_code: "USD" },
              },
            ],
            refunds: [
              {
                id: "EXTERNAL",
                status: "COMPLETED",
                amount: { value: "8.00", currency_code: "USD" },
              },
            ],
          },
        },
      ],
    });
    paypal.getRefund.mockResolvedValueOnce({
      id: "EXTERNAL",
      status: "COMPLETED",
      amount: { value: "8.00", currency_code: "USD" },
    });
    await expect(service.approve("case1", reviewed(service))).rejects.toThrow(
      "unallocated refund",
    );
    expect(paypal.refund).not.toHaveBeenCalled();
  });
  it("requires manual review when an uncertain request is too old to retry", async () => {
    const { service, store } = setup();
    store.saveAttempt({
      id: "old-key",
      revision: 1,
      snapshot: {
        revision: 1,
        amountCents: 800,
        allocations: [{ item: "mug", cents: 800 }],
        facts: context.facts,
        clauseIds: ["P1.1"],
        order,
        duplicateOverride: null,
      },
      caseId: "case1",
      orderId: order.id,
      requestId: "old-key",
      amountCents: 800,
      currency: "USD",
      allocations: [{ item: "mug", cents: 800 }],
      state: "uncertain",
      createdAt: "2020-01-01T00:00:00Z",
    });
    await expect(service.approve("case1", reviewed(service))).rejects.toThrow(
      "over an hour old",
    );
  });
  it("rejects cross-origin mutations and supports atomic JSON inbox import", async () => {
    const { app, store } = setup();
    expect(
      (
        await app.request("/api/cases/case1/approve", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const response = await app.request("/api/inbox/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          sender: "New Buyer",
          email: "new@example.test",
          subject: "Refund",
          message: "Cracked handle",
        },
      ]),
    });
    expect(response.status).toBe(201);
    expect(store.listCases()).toHaveLength(2);
  });
});
describe("AI schema boundary", () => {
  it("retries invalid output once and then marks it unavailable", async () => {
    const generate = vi.fn(async () => ({ bad: true }));
    expect(await validatedTriage(generate)).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("accepts a valid second answer and has no money-moving tools", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ bad: true })
      .mockResolvedValueOnce(proposal);
    expect(await validatedTriage(generate)).toEqual(proposal);
    const { store } = setup();
    expect(Object.keys(readonlyTools(store))).toEqual([
      "lookup_orders",
      "read_policies",
    ]);
  });
});

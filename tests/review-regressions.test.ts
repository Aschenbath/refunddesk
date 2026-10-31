import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Store } from "../src/server/db.js";
import { DeskService, IDEMPOTENCY_WINDOW_MS } from "../src/server/service.js";
import { createApp } from "../src/server/app.js";
import { config, validateOwnerConfiguration } from "../src/server/config.js";
import { emptyFacts, type DeskCase, type Facts } from "../src/core/types.js";
import {
  PayPalClient,
  PayPalError,
  type PayPalRefund,
  type PayPalOrder,
} from "../src/server/paypal.js";
import { reconcile, ledgerRow } from "../src/server/reconcile.js";
import {
  candidatesFor,
  readonlyTools,
  referencesFor,
  validatedTriage,
} from "../src/server/triage.js";
import * as triageModule from "../src/server/triage.js";
import * as ai from "ai";
import { seedCapture, seedRefund } from "../src/server/seed-operations.js";
import { boundedBody, RateLimits } from "../src/server/auth.js";
import { guard } from "../src/core/guardrails.js";
import { calculate } from "../src/core/calculator.js";
import { redactError } from "../src/server/errors.js";
import { order, proposal, context } from "./fixtures/domain.js";
vi.mock("ai", { spy: true });

const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});
function setup(password = "test-owner-password") {
  const store = new Store(":memory:");
  stores.push(store);
  store.saveOrder(structuredClone(order));
  const remote: PayPalRefund[] = [];
  let receiptStatus = "COMPLETED";
  const paypal = {
    getCapture: vi.fn(async () => ({
      id: order.captureId,
      status: remote.some((item) => item.status === "COMPLETED")
        ? "PARTIALLY_REFUNDED"
        : "COMPLETED",
      amount: { value: "56.00", currency_code: "USD" },
    })),
    getOrder: vi.fn(async () => ({
      id: order.paypalOrderId,
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: order.captureId,
                status: "COMPLETED",
                amount: { value: "56.00", currency_code: "USD" },
              },
            ],
            refunds: remote,
          },
        },
      ],
    })),
    getRefund: vi.fn(async (id: string) =>
      structuredClone(remote.find((receipt) => receipt.id === id)!),
    ),
    refund: vi.fn(
      async (
        _capture: string,
        cents: number,
        currency: string,
        _key: string,
        attemptId: string,
      ) => {
        const receipt: PayPalRefund = {
          id: `REFUND-${remote.length + 1}`,
          status: receiptStatus,
          amount: { value: (cents / 100).toFixed(2), currency_code: currency },
          invoice_id: attemptId,
          custom_id: attemptId,
        };
        remote.push(receipt);
        return structuredClone(receipt);
      },
    ),
    verifyWebhook: vi.fn(
      async (_headers: Headers, _event: unknown, _id: string, _raw?: string) =>
        true,
    ),
  };
  const value: DeskCase = {
    id: "case-review",
    revision: 1,
    sender: order.customerName,
    email: order.email,
    subject: "Refund",
    message: "FC-1001: both mugs have cracked handles. Refund please.",
    createdAt: new Date().toISOString(),
    status: "ready",
    orderId: order.id,
    proposal: structuredClone(proposal),
    proposedFacts: structuredClone(context.facts),
    confirmedFacts: structuredClone(context.facts),
    approvedCents: 800,
    replyDraft: "",
    replySent: false,
    fixture: null,
    manualOrder: false,
    duplicateOverride: null,
    error: null,
  };
  store.saveCase(value);
  const service = new DeskService(store, paypal as unknown as PayPalClient);
  const app = createApp(service, {
    ownerPassword: password,
    sessionSecret: "test-session-secret",
    nodeEnv: "test",
    publicOrigin: "https://desk.example",
    getIp: () => "127.0.0.1",
  });
  const reviewed = () => {
    const value = service.detail("case-review");
    return {
      revision: value.revision,
      approvedCents: value.check!.approvedCents,
    };
  };
  return {
    store,
    service,
    paypal,
    app,
    value,
    remote,
    reviewed,
    setStatus: (status: string) => {
      receiptStatus = status;
    },
  };
}
async function login(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/sign-in", {
    method: "POST",
    body: JSON.stringify({ password: "test-owner-password" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

describe("owner authentication and request limits", () => {
  it("protects all customer reads and mutations even without an Origin header", async () => {
    const { app, paypal } = setup();
    for (const [path, method] of [
      ["/cases", "GET"],
      ["/cases/case-review", "GET"],
      ["/orders", "GET"],
      ["/ledger", "GET"],
      ["/cases/case-review", "PATCH"],
      ["/cases/case-review/approve", "POST"],
      ["/triage", "POST"],
      ["/reconcile", "POST"],
      ["/inbox/import", "POST"],
      ["/cases/case-review/reject", "POST"],
      ["/cases/case-review/check-paypal", "POST"],
      ["/cases/case-review/retry-new-id", "POST"],
    ])
      expect((await app.request(`/api${path}`, { method })).status).toBe(401);
    expect(paypal.refund).not.toHaveBeenCalled();
  });
  it("issues HttpOnly Strict signed cookies and rejects forged or expired sessions", async () => {
    const { app } = setup();
    const response = await app.request("/api/sign-in", {
      method: "POST",
      body: JSON.stringify({ password: "test-owner-password" }),
    });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(
      (
        await app.request("/api/cases", {
          headers: { Cookie: cookie.split(";")[0] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/cases", {
          headers: { Cookie: cookie.split(";")[0] + "tampered" },
        })
      ).status,
    ).toBe(401);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 9 * 3600000);
    expect(
      (
        await app.request("/api/cases", {
          headers: { Cookie: cookie.split(";")[0] },
        })
      ).status,
    ).toBe(401);
  });
  it("allows passwordless development only from the socket loopback, never forwarded headers", async () => {
    const { service } = setup();
    const remote = createApp(service, {
      ownerPassword: "",
      nodeEnv: "development",
      getIp: () => "198.51.100.7",
    });
    expect(
      (
        await remote.request("http://localhost/api/cases", {
          headers: { "X-Forwarded-For": "127.0.0.1" },
        })
      ).status,
    ).toBe(401);
    const local = createApp(service, {
      ownerPassword: "",
      nodeEnv: "development",
      getIp: () => "::1",
    });
    expect((await local.request("/api/cases")).status).toBe(200);
    const production = createApp(service, {
      ownerPassword: "",
      nodeEnv: "production",
      getIp: () => "127.0.0.1",
    });
    expect((await production.request("/api/cases")).status).toBe(401);
    expect(() =>
      validateOwnerConfiguration({
        ...config,
        ownerPassword: "",
        nodeEnv: "production",
      }),
    ).toThrow("OWNER_PASSWORD");
  });
  it("accepts the configured HTTPS origin through an HTTP proxy and rejects other origins", async () => {
    const { app } = setup();
    const cookie = await login(app);
    const body = JSON.stringify({ replyDraft: "Owner edited reply" });
    expect(
      (
        await app.request("http://internal/api/cases/case-review", {
          method: "PATCH",
          headers: { Cookie: cookie, Origin: "https://desk.example" },
          body,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("http://internal/api/cases/case-review", {
          method: "PATCH",
          headers: { Cookie: cookie, Origin: "http://localhost:15481" },
          body,
        })
      ).status,
    ).toBe(403);
  });
  it("limits actual chunked UTF-8 bytes without trusting Content-Length", async () => {
    const { app } = setup();
    const cookie = await login(app);
    const chunks = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("é".repeat(500001)));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/inbox/import", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Length": "1" },
      body: chunks,
      duplex: "half",
    } as RequestInit);
    expect((await app.fetch(request)).status).toBe(413);
    expect(
      await boundedBody(
        new Request("http://localhost", { method: "POST", body: "é" }),
        2,
      ),
    ).toBe("é");
  });
  it("rate limits sign-in, imports and triage per socket IP", async () => {
    const { app } = setup();
    const cookie = await login(app);
    for (const path of ["/api/sign-in", "/api/inbox/import", "/api/triage"]) {
      let last = 0;
      for (let i = 0; i < 22; i++)
        last = (
          await app.request(path, {
            method: "POST",
            headers: { Cookie: cookie },
            body: "{}",
          })
        ).status;
      expect(last).toBe(429);
    }
    const limits = new RateLimits();
    expect(limits.allow("a", 1, 0)).toBe(true);
    expect(limits.allow("a", 1, 1)).toBe(false);
    expect(limits.allow("b", 1, 1)).toBe(true);
    expect(limits.allow("a", 1, 60001)).toBe(true);
  });
  it("bounds concurrent triage to two jobs", async () => {
    const { service } = setup();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generated = vi
      .spyOn(triageModule, "triage")
      .mockImplementation(async () => {
        await waiting;
        return { proposal, unavailable: false };
      });
    const ids = [1, 2, 3].map(
      () =>
        service.createMessage({
          sender: order.customerName,
          email: order.email,
          subject: "Refund",
          message: "FC-1001: mug cracked; refund please",
        }).id,
    );
    const first = service.triageCase(ids[0]),
      second = service.triageCase(ids[1]);
    await expect(service.triageCase(ids[2])).rejects.toMatchObject({
      status: 429,
    });
    expect(generated).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
  });
});

describe("approval and human fact boundary", () => {
  it("rejects missing, stale or changed reviewed amounts before calling PayPal", async () => {
    const { app, service, reviewed, paypal } = setup();
    const cookie = await login(app);
    const request = (body: unknown) =>
      app.request("/api/cases/case-review/approve", {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify(body),
      });
    expect((await request({})).status).toBe(400);
    const old = reviewed();
    service.edit("case-review", { approvedCents: 1600 });
    expect((await request(old)).status).toBe(409);
    expect((await request({ ...reviewed(), approvedCents: 800 })).status).toBe(
      409,
    );
    expect(paypal.refund).not.toHaveBeenCalled();
  });
  it("rejects an amount edit during reconciliation and freezes every approved input", async () => {
    const { service, paypal, reviewed, store } = setup();
    const expected = reviewed();
    const capture = paypal.getCapture.getMockImplementation()!;
    paypal.getCapture.mockImplementationOnce(async () => {
      service.edit("case-review", { approvedCents: 1600 });
      return capture();
    });
    await expect(service.approve("case-review", expected)).rejects.toThrow(
      "This case changed; review again",
    );
    expect(paypal.refund).not.toHaveBeenCalled();
    const current = reviewed();
    await service.approve("case-review", current);
    expect(store.getAttempt("case-review")!.snapshot).toMatchObject({
      revision: current.revision,
      amountCents: 1600,
      allocations: [{ item: "mug", cents: 1600 }],
      clauseIds: ["P1.1", "P1.2"],
      facts: context.facts,
      order,
    });
  });
  it("bumps revisions for facts, amount, order, override, replies and triage", async () => {
    const { service } = setup();
    let revision = service.detail("case-review").revision;
    for (const changes of [
      {
        confirmedFacts: {
          ...context.facts,
          damagedItems: [{ item: "mug", quantity: 1 }],
        },
      },
      { clauseIds: ["P1.1"] },
      { approvedCents: 100 },
      { orderId: order.id },
      { duplicateOverride: "Verified separate issue" },
      { replyDraft: "Owner reply" },
      { replySent: true },
    ]) {
      const value = service.edit("case-review", changes);
      expect(value.revision).toBeGreaterThan(revision);
      revision = value.revision;
    }
    vi.spyOn(triageModule, "triage").mockResolvedValue({
      proposal,
      unavailable: false,
    });
    expect((await service.triageCase("case-review")).revision).toBeGreaterThan(
      revision,
    );
  });
  it("refunds one damaged unit, excludes undamaged units and requires confirmed dates", () => {
    const facts = {
      ...emptyFacts(),
      damagedItems: [{ item: "mug", quantity: 1 }],
      hasDamageEvidence: true,
    };
    expect(calculate(order, ["P1.1"], facts, context.now).lines).toEqual([
      { item: "mug", cents: 2400 },
    ]);
    expect(
      calculate(order, ["P1.1", "P1.2"], facts, context.now).lines,
    ).toEqual([]);
    expect(calculate(order, ["P2.1"], facts, context.now).lines).toEqual([]);
    expect(
      calculate(
        order,
        ["P3.1"],
        {
          ...facts,
          returnedItems: [{ item: "mug", quantity: 1 }],
          returnReceived: true,
        },
        context.now,
      ).lines,
    ).toEqual([]);
  });
  it("never gives any model output more allowance than the human-confirmed facts allow", async () => {
    const { service } = setup();
    const generated = vi.spyOn(triageModule, "triage");
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          total: fc.integer({ min: 0, max: 1_000_000 }),
          quantity: fc.integer({ min: 1, max: 100 }),
          clauses: fc.array(
            fc.constantFrom("P1.1", "P1.2", "P2.1", "P2.2", "P3.1", "P9.1"),
            { maxLength: 8 },
          ),
          evidence: fc.boolean(),
          returned: fc.boolean(),
          selected: fc.constantFrom("mug", "invented", "shipping"),
        }),
        async (output) => {
          const model = {
            ...proposal,
            proposed_total: output.total,
            policy_clause_ids: output.clauses,
            proposed_lines: [
              {
                item: output.selected,
                amount: output.total,
                reason: "untrusted model",
              },
            ],
            proposed_facts: {
              ...emptyFacts(),
              damagedItems: [
                { item: output.selected, quantity: output.quantity },
              ],
              hasDamageEvidence: output.evidence,
              returnedItems: [
                { item: output.selected, quantity: output.quantity },
              ],
              returnReceived: output.returned,
              deliveryDates: {
                promisedAt: "2020-01-01",
                deliveredAt: "2026-10-20",
              },
            },
          };
          generated.mockResolvedValue({ proposal: model, unavailable: false });
          const value = service.createMessage({
            sender: order.customerName,
            email: order.email,
            subject: "Refund",
            message: "FC-1001: one mug has a cracked handle; refund please",
          });
          const triaged = await service.triageCase(value.id);
          expect(triaged.confirmedFacts).toEqual(emptyFacts());
          expect(triaged.check!.computedCents).toBe(0);
          const confirmed = service.edit(value.id, {
            confirmedFacts: {
              ...emptyFacts(),
              damagedItems: [{ item: "mug", quantity: 1 }],
              hasDamageEvidence: true,
            },
          });
          expect(confirmed.check!.computedCents).toBeLessThanOrEqual(2400);
        },
      ),
      { numRuns: 150 },
    );
  });
  it("detects every order reference and identity conflict, and limits lookup tools to that case", async () => {
    const { store, service, value } = setup();
    const other = {
      ...order,
      id: "FC-1002",
      customerName: "Theo Bennett",
      email: "theo@example.test",
    };
    store.saveOrder(other);
    const unrelated = {
      ...order,
      id: "FC-1003",
      customerName: "Unrelated Buyer",
      email: "private@example.test",
    };
    store.saveOrder(unrelated);
    value.message = "FC-1001 was fine; refund FC-1002 and 1002";
    store.saveCase(value);
    expect(referencesFor(value)).toEqual(["FC-1001", "FC-1002"]);
    expect(candidatesFor(store, value).map((order) => order.id)).toEqual([
      "FC-1001",
      "FC-1002",
    ]);
    expect(service.detail(value.id).ambiguous).toBe(true);
    expect(service.detail(value.id).check!.kind).toBe("blocked");
    const lookup = readonlyTools(store, value).lookup_orders.execute!;
    expect(
      await lookup(
        { partialId: "100" },
        { toolCallId: "test", messages: [], context: {} },
      ),
    ).toHaveLength(2);
    expect(
      await lookup(
        { email: unrelated.email },
        { toolCallId: "test", messages: [], context: {} },
      ),
    ).toEqual([]);
    value.message = "FC-1001 cracked handle";
    value.email = other.email;
    store.saveCase(value);
    expect(service.detail(value.id).ambiguous).toBe(true);
    value.email = order.email;
    value.sender = "Wrong Name";
    store.saveCase(value);
    expect(service.detail(value.id).ambiguous).toBe(true);
    expect(service.edit(value.id, { orderId: order.id }).ambiguous).toBe(false);
  });
  it("resolves one explicit reference among several orders owned by the same matching customer", () => {
    const { store, service } = setup();
    store.saveOrder({ ...order, id: "FC-1016" });
    expect(service.detail("case-review").ambiguous).toBe(false);
    expect(service.detail("case-review").check!.kind).toBe("adjusted");
  });
  it("invalidates approval if the selected order record changes during the PayPal lookup", async () => {
    const { store, service, paypal, reviewed } = setup();
    const original = paypal.getCapture.getMockImplementation()!;
    paypal.getCapture.mockImplementationOnce(async () => {
      store.saveOrder({ ...order, shippingCents: 1000 });
      return original();
    });
    await expect(service.approve("case-review", reviewed())).rejects.toThrow(
      "This case changed; review again",
    );
    expect(paypal.refund).not.toHaveBeenCalled();
  });
  it("charges each return case its own $6 fee using only its confirmed items", async () => {
    const { store, service, value, paypal, remote } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const two = {
      ...order,
      deliveredAt: today,
      lines: ["A", "B"].map((id) => ({
        ...order.lines[0],
        id,
        quantity: 1,
        unitCents: 2000,
      })),
    };
    store.saveOrder(two);
    const facts: Facts = {
      ...emptyFacts(),
      returnReceived: true,
      deliveryDates: { promisedAt: today, deliveredAt: today },
      returnedItems: [{ item: "A", quantity: 1 }],
    };
    store.saveCase({
      ...value,
      approvedCents: null,
      confirmedFacts: facts,
      proposal: { ...proposal, policy_clause_ids: ["P3.1"] },
    });
    await service.approve(value.id, {
      revision: service.detail(value.id).revision,
      approvedCents: 1400,
    });
    expect(store.listRefunds()[0].returnFeeCaseId).toBe(value.id);
    store.saveCase({
      ...value,
      id: "later",
      createdAt: new Date(Date.now() + 1).toISOString(),
      approvedCents: null,
      confirmedFacts: { ...facts, returnedItems: [{ item: "B", quantity: 1 }] },
      duplicateOverride: "Confirmed a separate return parcel",
      proposal: { ...proposal, policy_clause_ids: ["P3.1"] },
    });
    const later = service.detail("later");
    expect(later.check!.computedCents).toBe(1400);
    await service.approve("later", {
      revision: later.revision,
      approvedCents: 1400,
    });
    expect(remote).toHaveLength(2);
    expect(paypal.refund).toHaveBeenCalledTimes(2);
    expect(store.listRefunds()[1].returnFeeCaseId).toBe("later");
  });
});

describe("PayPal lifecycle, recovery and exact reconciliation", () => {
  it("caps a return against earlier damage allocations without removing another return case's fee", () => {
    const today = new Date().toISOString().slice(0, 10);
    const two = {
      ...order,
      lines: ["A", "B"].map((id) => ({
        ...order.lines[0],
        id,
        unitCents: 2000,
        quantity: 1,
      })),
    };
    const result = guard({
      ...context,
      now: today,
      order: two,
      proposal: { ...proposal, policy_clause_ids: ["P3.1"] },
      facts: {
        ...emptyFacts(),
        returnedItems: [{ item: "A", quantity: 1 }],
        returnReceived: true,
        deliveryDates: { promisedAt: today, deliveredAt: today },
      },
      refundedCents: 1500,
      refundedByLine: { A: 1500 },
    });
    expect(result.computedCents).toBe(500);
  });
  it.each(["COMPLETED", "FAILED"])(
    "keeps PENDING open and atomically applies a later %s receipt",
    async (status) => {
      const { service, store, remote, reviewed, setStatus } = setup();
      setStatus("PENDING");
      const first = await service.approve("case-review", reviewed());
      expect(first.case.status).toBe("pending");
      expect(first.ledger).toMatchObject({
        pendingCents: 800,
        refundedCents: 0,
        paypalStatus: "REFUND_PENDING",
        match: true,
      });
      remote[0].status = status;
      const row = await reconcile(store, service.paypal, order.id);
      expect(store.getCase("case-review")!.status).toBe(
        status === "COMPLETED" ? "refunded" : "needs_human",
      );
      expect(store.getAttempt("case-review")!.state).toBe(
        status === "COMPLETED" ? "completed" : "failed",
      );
      expect(row).toMatchObject({
        pendingCents: 0,
        refundedCents: status === "COMPLETED" ? 800 : 0,
        match: true,
      });
      if (status === "FAILED")
        expect(store.getCase("case-review")!.error).toContain("failed");
    },
  );
  it("recovers a created refund after its response is lost without creating a second refund", async () => {
    const { service, paypal, store, reviewed } = setup();
    const original = paypal.refund.getMockImplementation()!;
    paypal.refund.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("lost response with secret request payload");
    });
    await expect(service.approve("case-review", reviewed())).rejects.toThrow();
    const attempt = store.getAttempt("case-review")!;
    attempt.createdAt = new Date(
      Date.now() - 2 * IDEMPOTENCY_WINDOW_MS,
    ).toISOString();
    store.saveAttempt(attempt);
    const recovered = await service.checkPayPal("case-review");
    expect(recovered.recovered).toBe(true);
    expect(recovered.case.status).toBe("refunded");
    expect(recovered.ledger.match).toBe(true);
    expect(paypal.refund).toHaveBeenCalledTimes(1);
    expect(store.listRefunds()).toHaveLength(1);
    expect(store.getCase("case-review")!.error).toBeNull();
  });
  it("allows an explicit new request id only after a fresh absent-receipt check, expiry and reason", async () => {
    const { service, paypal, store, reviewed } = setup();
    paypal.refund.mockRejectedValueOnce(new Error("lost before creation"));
    await expect(service.approve("case-review", reviewed())).rejects.toThrow();
    const original = store.getAttempt("case-review")!;
    await expect(
      service.retryWithNewId("case-review", {
        confirmed: true,
        reason: "Checked missing payment",
        revision: reviewed().revision,
      }),
    ).rejects.toThrow("Retry unavailable");
    original.createdAt = new Date(
      Date.now() - 2 * IDEMPOTENCY_WINDOW_MS,
    ).toISOString();
    store.saveAttempt(original);
    const check = await service.checkPayPal("case-review");
    expect(check.retryAllowed).toBe(true);
    expect(paypal.refund).toHaveBeenCalledTimes(1);
    await expect(
      service.retryWithNewId("case-review", {
        confirmed: false,
        reason: "Checked missing payment",
        revision: reviewed().revision,
      }),
    ).rejects.toThrow("warning");
    const done = await service.retryWithNewId("case-review", {
      confirmed: true,
      reason: "Owner checked no matching receipt",
      revision: reviewed().revision,
    });
    expect(done.case.status).toBe("refunded");
    expect(store.getAttempt("case-review")!.requestId).not.toBe(
      original.requestId,
    );
    expect(store.getAttempt("case-review")!.id).toBe(original.id);
    expect(store.getAttempt("case-review")!.retryHistory![0].reason).toContain(
      "Owner checked",
    );
  });
  it("refuses recovery when a found receipt has the wrong amount", async () => {
    const { service, paypal, remote, reviewed, store } = setup();
    const original = paypal.refund.getMockImplementation()!;
    paypal.refund.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("lost");
    });
    await expect(service.approve("case-review", reviewed())).rejects.toThrow();
    remote[0].amount.value = "16.00";
    await expect(service.checkPayPal("case-review")).rejects.toThrow(
      "frozen approval",
    );
    expect(store.listRefunds()).toHaveLength(0);
    expect(store.getAttempt("case-review")!.state).toBe("uncertain");
  });
  it("marks interrupted submitted attempts uncertain on restart", async () => {
    const { service, store, paypal, reviewed } = setup();
    paypal.refund.mockRejectedValueOnce(new Error("lost"));
    await expect(service.approve("case-review", reviewed())).rejects.toThrow();
    const attempt = store.getAttempt("case-review")!;
    attempt.state = "submitted";
    store.saveAttempt(attempt);
    service.recoverInterrupted();
    expect(store.getAttempt("case-review")!.state).toBe("uncertain");
    expect(store.getCase("case-review")!.error).toContain("Interrupted");
  });
  it("rejects an unrelated same-value capture and same-total swapped refund amounts", async () => {
    const { store, paypal, remote, service } = setup();
    paypal.getOrder.mockResolvedValueOnce({
      id: order.paypalOrderId,
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: "UNRELATED",
                status: "COMPLETED",
                amount: { value: "56.00", currency_code: "USD" },
              },
            ],
            refunds: [],
          },
        },
      ],
    });
    await expect(reconcile(store, service.paypal, order.id)).rejects.toThrow(
      "does not belong",
    );
    expect(ledgerRow(store, order.id).match).toBe(false);
    for (const [index, local, remoteCents] of [
      [1, 1000, 500],
      [2, 500, 1000],
    ]) {
      store.saveRefund({
        id: `r${index}`,
        caseId: null,
        orderId: order.id,
        amountCents: local,
        currency: "USD",
        status: "COMPLETED",
        requestId: `key${index}`,
        allocations: [],
        createdAt: new Date().toISOString(),
      });
      remote.push({
        id: `r${index}`,
        status: "COMPLETED",
        amount: { value: (remoteCents / 100).toFixed(2), currency_code: "USD" },
      });
    }
    const row = await reconcile(store, service.paypal, order.id);
    expect(row.remoteRefundedCents).toBe(row.refundedCents);
    expect(row.match).toBe(false);
  });
  it("flags unknown remote refunds separately and never certifies a wrong capture association or status", async () => {
    const { store, remote, service } = setup();
    remote.push({
      id: "outside",
      status: "COMPLETED",
      amount: { value: "8.00", currency_code: "USD" },
    });
    const unexpected = await reconcile(store, service.paypal, order.id);
    expect(unexpected.unexpectedRefundIds).toEqual(["outside"]);
    expect(unexpected.error).toContain("Unexpected refund");
    remote[0].supplementary_data = { related_ids: { capture_id: "UNRELATED" } };
    await expect(reconcile(store, service.paypal, order.id)).rejects.toThrow(
      "association",
    );
    delete remote[0].supplementary_data;
    store.saveRefund({
      id: "outside",
      caseId: null,
      orderId: order.id,
      amountCents: 800,
      currency: "USD",
      status: "COMPLETED",
      requestId: "key",
      allocations: [],
      createdAt: new Date().toISOString(),
    });
    remote[0].status = "PENDING";
    expect((await reconcile(store, service.paypal, order.id)).match).toBe(
      false,
    );
    expect(store.listRefunds()[0].status).toBe("COMPLETED");
  });
});

describe("webhooks, seeding and provider failure", () => {
  it("verifies untouched JSON and raw bytes before schema stripping and handles all refund event types", async () => {
    const { app, paypal } = setup();
    vi.spyOn(config, "webhookId", "get").mockReturnValue("webhook-test");
    for (const type of [
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.REFUND.PENDING",
      "PAYMENT.REFUND.FAILED",
    ]) {
      const event = {
        id: type,
        event_type: type,
        arbitrary: "preserve",
        resource: {
          id: "receipt",
          supplementary_data: {
            related_ids: {
              capture_id: order.captureId,
              order_id: order.paypalOrderId,
              extra: "preserve",
            },
          },
          links: [
            {
              rel: "up",
              href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${order.captureId}`,
              method: "GET",
            },
          ],
        },
      };
      const raw = JSON.stringify(event, null, 2);
      expect(
        (
          await app.request("/api/webhooks/paypal", {
            method: "POST",
            body: raw,
          })
        ).status,
      ).toBe(200);
      expect(paypal.verifyWebhook.mock.calls.at(-1)![1]).toEqual(event);
      expect(paypal.verifyWebhook.mock.calls.at(-1)![3]).toBe(raw);
    }
    expect(paypal.getCapture).toHaveBeenCalledTimes(3);
  });
  it("never acts on unverified development webhooks and returns 503 in production without a webhook ID", async () => {
    const { service, paypal } = setup();
    vi.spyOn(config, "webhookId", "get").mockReturnValue("");
    const event = {
      id: "unsigned",
      event_type: "PAYMENT.REFUND.FAILED",
      resource: {},
    };
    const dev = createApp(service, { nodeEnv: "development" });
    const prod = createApp(service, { nodeEnv: "production" });
    const response = await dev.request("/api/webhooks/paypal", {
      method: "POST",
      body: JSON.stringify(event),
    });
    expect(await response.json()).toMatchObject({
      signatureVerification: "unverified",
      acted: false,
    });
    expect(
      (
        await prod.request("/api/webhooks/paypal", {
          method: "POST",
          body: JSON.stringify(event),
        })
      ).status,
    ).toBe(503);
    expect(paypal.getCapture).not.toHaveBeenCalled();
  });
  it("persists seed capture intent before a lost response and reuses the capture on restart", async () => {
    const { store } = setup();
    const batch = store.seedBatch();
    const remote: PayPalOrder = {
      id: "seed-order",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: "seed-capture",
                status: "COMPLETED",
                amount: { value: "56.00", currency_code: "USD" },
              },
            ],
          },
        },
      ],
    };
    const paypal = {
      createAndCapture: vi.fn(
        async (_amount: number, invoice: string, key: string) => {
          const intent = store.getSeedIntent(
            `capture:${batch.id}:${order.id}`,
          )!;
          expect(intent.requestId).toBe(key);
          expect(intent.invoiceId).toBe(invoice);
          expect(intent.state).toBe("uncertain");
          throw new Error("lost after creation");
        },
      ),
      findCaptureByInvoice: vi.fn(async () => ({
        order: remote,
        capture: remote.purchase_units![0].payments!.captures![0],
      })),
      getOrder: vi.fn(async () => remote),
    };
    await expect(
      seedCapture(store, paypal as unknown as PayPalClient, batch.id, order),
    ).rejects.toThrow("lost");
    expect(store.seedBatch().id).toBe(batch.id);
    const recovered = await seedCapture(
      store,
      paypal as unknown as PayPalClient,
      batch.id,
      order,
    );
    expect(recovered.captureId).toBe("seed-capture");
    expect(paypal.createAndCapture).toHaveBeenCalledTimes(1);
    expect(paypal.findCaptureByInvoice).toHaveBeenCalledTimes(1);
    expect(store.seedBatch(true).id).not.toBe(batch.id);
  });
  it("recovers a seed refund by invoice after the request-id window without a second refund", async () => {
    const { store, paypal, service } = setup();
    const batch = store.seedBatch();
    const original = paypal.refund.getMockImplementation()!;
    paypal.refund.mockImplementationOnce(async (...args) => {
      expect(
        store.getSeedIntent(`refund:${batch.id}:${order.id}`),
      ).not.toBeNull();
      await original(...args);
      throw new Error("lost seed refund response");
    });
    await expect(
      seedRefund(store, service.paypal, batch.id, order, 1200),
    ).rejects.toThrow();
    const intent = store.getSeedIntent(`refund:${batch.id}:${order.id}`)!;
    intent.createdAt = "2020-01-01T00:00:00Z";
    store.saveSeedIntent(intent);
    const found = await seedRefund(
      store,
      service.paypal,
      batch.id,
      order,
      1200,
    );
    expect(found.invoice_id).toBe(intent.invoiceId);
    expect(paypal.refund).toHaveBeenCalledTimes(1);
    expect(store.listRefunds()[0].amountCents).toBe(1200);
  });
  it("redacts provider errors to class and status and uses keyword triage when AI is unavailable", async () => {
    const error = Object.assign(
      new Error("API_KEY=private request body and customer data"),
      { name: "ProviderError", status: 503 },
    );
    expect(redactError(error)).toBe("ProviderError (HTTP 503)");
    expect(new PayPalError(422, { message: error.message }).message).toBe(
      "PayPalError (HTTP 422)",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await validatedTriage(async () => {
        throw error;
      }),
    ).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private");
    const { service } = setup();
    vi.spyOn(config, "aiMode", "get").mockReturnValue("online");
    vi.spyOn(config, "aiApiKey", "get").mockReturnValue("");
    const value = service.createMessage({
      sender: order.customerName,
      email: order.email,
      subject: "Refund",
      message: "FC-1001: mug has a cracked handle. Refund please",
    });
    const result = await service.triageCase(value.id);
    expect(result.proposal!.proposed_lines.length).toBeGreaterThan(0);
    expect(result.replyDraft).not.toBe("");
    expect(result.error).toContain("AI unavailable");
    expect(result.confirmedFacts).toEqual(emptyFacts());
  });
  it("falls back to keyword triage after a configured online provider fails twice", async () => {
    const { service } = setup();
    vi.spyOn(config, "aiMode", "get").mockReturnValue("online");
    vi.spyOn(config, "aiBaseUrl", "get").mockReturnValue(
      "https://provider.example/v1",
    );
    vi.spyOn(config, "aiApiKey", "get").mockReturnValue("synthetic-key");
    vi.spyOn(config, "aiModel", "get").mockReturnValue("synthetic-model");
    const generate = vi.mocked(ai.generateText).mockRejectedValue(
      Object.assign(new Error("secret provider request"), {
        statusCode: 503,
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = service.createMessage({
      sender: order.customerName,
      email: order.email,
      subject: "Refund",
      message: "FC-1001 has a cracked handle. Refund please.",
    });
    const result = await service.triageCase(value.id);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.proposal!.proposed_lines).not.toHaveLength(0);
    expect(result.replyDraft).not.toBe("");
    expect(result.error).toContain("AI unavailable");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, type Attempt } from "../src/server/db.js";
import { DeskService } from "../src/server/service.js";
import { createApp } from "../src/server/app.js";
import { createCaseReport } from "../src/server/case-report.js";
import { hydrateReplay, loadSnapshot, ReplayPayPalClient } from "../src/server/replay.js";
import type { Refund } from "../src/core/types.js";

const stores: Store[] = [];
const generatedAt = "2026-11-09T10:00:00.000Z";
const caseId = "case-seed-06";
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const snapshot = loadSnapshot();
  hydrateReplay(store, snapshot);
  const paypal = new ReplayPayPalClient(store, snapshot);
  const service = new DeskService(store, paypal, { aiMode: "offline" });
  return { store, service, paypal };
}

function savedAttempt(store: Store, service: DeskService, state: Attempt["state"] = "uncertain"): Attempt {
  const value = service.detail(caseId);
  const amountCents = value.check!.approvedCents;
  const attempt: Attempt = {
    id: "attempt-report", caseId, orderId: value.orderId!, requestId: "request-report", state,
    amountCents, currency: value.order!.currency, allocations: value.check!.lines,
    createdAt: "2026-11-08T10:00:00.000Z", revision: value.revision,
    snapshot: {
      revision: value.revision, amountCents, allocations: value.check!.lines,
      clauseIds: value.proposal!.policy_clause_ids, facts: value.confirmedFacts,
      order: value.order!, duplicateOverride: value.duplicateOverride,
    },
  };
  store.saveAttempt(attempt);
  store.saveCase({ ...value, approvedCents: amountCents, approvalCheck: value.check,
    status: state === "pending" ? "pending" : state === "completed" ? "refunded" : "needs_human", error: state === "uncertain" ? "Outcome uncertain" : null });
  return attempt;
}

function receipt(changes: Partial<Refund> = {}): Refund {
  return {
    id: "REPLAY-report", caseId, orderId: "FC-1005", amountCents: 7200, currency: "USD",
    status: "COMPLETED", requestId: "request-report", allocations: [],
    createdAt: "2026-11-08T10:00:00.000Z", ...changes,
  };
}

function databaseState(store: Store) {
  const tables = ["products", "customers", "policies", "orders", "cases", "refunds", "ledger", "attempts", "webhook_events", "seed_intents", "seed_batches"];
  return JSON.stringify(Object.fromEntries(tables.map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

describe("case decision report", () => {
  it("explains the recorded $140 proposal and $72 allowance without claiming an approval", () => {
    const { service } = setup();
    const report = createCaseReport(service, caseId, "replay", generatedAt);
    expect(report).toMatchObject({ formatVersion: 1, generatedAt, mode: "replay", case: { id: caseId, sender: "Priya Shah" } });
    expect(report.triage).toMatchObject({ source: "fixture", model: "recorded-demo-fixture", proposal: { proposed_total: 14000 }, calculatorAllowanceCents: 7200 });
    expect(report.review).toMatchObject({ selectedCents: null, checkBasis: "current", check: { computedCents: 7200, modelCents: 14000 }, confirmedFacts: { damagedItems: [{ item: "FC-1005-L1", quantity: 2 }] } });
    expect(report.review.check!.lines).toEqual([{ item: "FC-1005-L1", cents: 6400 }, { item: "shipping", cents: 800 }]);
    expect(report.approval).toBeNull();
    expect(report.attempt).toBeNull();
    expect(report.receipts).toEqual([]);
    expect(report.policies).toHaveLength(2);
    expect(report.policies.every((policy) => typeof policy.currentText === "string")).toBe(true);
  });

  it("keeps the original triage separate from owner edits and retains both sets of clause references", () => {
    const { service, store } = setup();
    service.edit(caseId, { clauseIds: ["P1.1"] });
    const value = store.getCase(caseId)!;
    value.proposal!.policy_clause_ids.push("P9.9");
    store.saveCase(value);
    const report = createCaseReport(service, caseId, "sandbox", generatedAt);
    expect(report.triage!.proposal.policy_clause_ids).toEqual(["P1.1", "P1.2"]);
    expect(report.review.proposal!.policy_clause_ids).toEqual(["P1.1", "P9.9"]);
    expect(report.policies.map((policy) => policy.id)).toEqual(["P1.1", "P1.2", "P9.9"]);
    expect(report.policies.find((policy) => policy.id === "P9.9")).toEqual({ id: "P9.9", currentText: null });
  });

  it("uses the frozen reviewed revision, facts and amount after approval and later order changes", async () => {
    const { service, store } = setup();
    const reviewed = service.edit(caseId, { approvedCents: 6400 });
    await service.approve(caseId, { revision: reviewed.revision, approvedCents: 6400 });
    const frozen = store.getAttempt(caseId)!.snapshot;
    const currentOrder = store.getOrder("FC-1005")!;
    store.saveOrder({ ...currentOrder, capturedCents: 99900, captureId: "changed-current-capture",
      lines: currentOrder.lines.map((line) => ({ ...line, title: "Changed current title", unitCents: 99900 })) });
    const report = createCaseReport(service, caseId, "replay", generatedAt);
    expect(report.approval).toMatchObject({ reviewedRevision: reviewed.revision, amountCents: 6400, currency: "USD", facts: frozen.facts,
      allocations: [{ item: "FC-1005-L1", cents: 6400 }], order: { capturedCents: 7200, captureId: frozen.order.captureId } });
    expect(report.approval!.order.lines[0].title).toBe("Tide Side Plate");
    expect(report.order).toMatchObject({ capturedCents: 99900, captureId: "changed-current-capture" });
    expect(report.case.revision).toBeGreaterThan(report.approval!.reviewedRevision);
    expect(report.review).toMatchObject({ checkBasis: "approval", check: { computedCents: 7200, approvedCents: 6400 } });
    expect(report.receipts).toHaveLength(1);
    expect(report.receipts[0]).toMatchObject({ amountCents: 6400, status: "COMPLETED", source: "simulated-replay" });
  });

  it.each(["pending", "uncertain", "failed"] as const)("retains %s as the saved outcome without declaring completion", (state) => {
    const { service, store } = setup();
    const attempt = savedAttempt(store, service, state);
    attempt.checkedAt = "2026-11-08T11:00:00.000Z";
    attempt.retryHistory = [{ requestId: "previous-request", createdAt: "2026-11-08T09:00:00.000Z", reason: "Owner investigated the earlier request" }];
    store.saveAttempt(attempt);
    if (state !== "uncertain") store.saveRefund(receipt({ status: state === "pending" ? "PENDING" : "FAILED" }));
    const report = createCaseReport(service, caseId, "replay", generatedAt);
    expect(report.attempt).toMatchObject({ state, createdAt: attempt.createdAt, checkedAt: attempt.checkedAt, priorRequests: attempt.retryHistory });
    expect(report.approval!.amountCents).toBe(7200);
    expect(report.receipts.some((value) => value.status === "COMPLETED")).toBe(false);
    expect(report.receipts).toHaveLength(state === "uncertain" ? 0 : 1);
    if (report.receipts[0]) expect(report.receipts[0].recordedAt).toBe(attempt.createdAt);
  });

  it("exports only this case's receipts for its order, with explicit replay and sandbox provenance", () => {
    const { store, service } = setup();
    store.saveRefund(receipt());
    store.saveRefund(receipt({ id: "recorded-sample", requestId: "recorded-request" }));
    store.saveRefund(receipt({ id: "other-case", caseId: "other", requestId: "other-case-request" }));
    store.saveRefund(receipt({ id: "other-order", orderId: "FC-1006", requestId: "other-order-request" }));
    store.saveRefund(receipt({ id: "unassigned", caseId: null, requestId: "unassigned-request" }));
    const report = createCaseReport(service, caseId, "replay", generatedAt);
    expect(report.receipts.map((value) => [value.id, value.source])).toEqual([
      ["REPLAY-report", "simulated-replay"], ["recorded-sample", "recorded-sandbox-sample"],
    ]);
    expect(createCaseReport(service, caseId, "sandbox", generatedAt).receipts.every((value) => value.source === "sandbox-record")).toBe(true);
  });

  it("does not fabricate a complete approval snapshot for older refunded samples", () => {
    const { store, service } = setup();
    const report = createCaseReport(service, "case-seed-01", "replay", generatedAt);
    expect(report.case.status).toBe("refunded");
    expect(report.approval).toBeNull();
    expect(report.attempt).toBeNull();
    expect(report.review.checkBasis).toBe("approval");
    expect(report.receipts[0].source).toBe("recorded-sandbox-sample");
    const value = store.getCase("case-seed-01")!;
    delete value.approvalCheck;
    store.saveCase(value);
    const withoutCheck = createCaseReport(service, value.id, "replay", generatedAt);
    expect(withoutCheck.review).toMatchObject({ checkBasis: "unavailable", check: null });
    expect(withoutCheck.approval).toBeNull();
  });

  it("keeps a legacy attempt without a snapshot visible but cannot reconstruct its approval", () => {
    const { store, service } = setup();
    const attempt = savedAttempt(store, service);
    delete (attempt as Partial<Attempt>).snapshot;
    store.saveAttempt(attempt);
    const value = store.getCase(caseId)!;
    delete value.approvalCheck;
    store.saveCase(value);
    const report = createCaseReport(service, caseId, "sandbox", generatedAt);
    expect(report.attempt!.id).toBe(attempt.id);
    expect(report.approval).toBeNull();
    expect(report.review.checkBasis).toBe("unavailable");
    expect(report.review.check).toBeNull();
  });

  it("represents untriaged cases and missing ledger records as unavailable", () => {
    const { store, service } = setup();
    const value = service.createMessage({ sender: "New customer", email: "new@example.test", subject: "New request", message: "Please review this new request." });
    const report = createCaseReport(service, value.id, "replay", generatedAt);
    expect(report).toMatchObject({ triage: null, order: null, approval: null, attempt: null, ledger: null, receipts: [], policies: [], review: { proposal: null, check: null, checkBasis: "unavailable", selectedCents: null } });
    store.db.prepare("DELETE FROM ledger WHERE order_id=?").run("FC-1005");
    expect(createCaseReport(service, caseId, "replay", generatedAt).ledger).toBeNull();
  });

  it("keeps stored ledger uncertainty and its check time instead of reconciling during export", () => {
    const { store, service } = setup();
    const ledger = store.getLedger("FC-1005")!;
    store.saveLedger({ ...ledger, match: false, checkedAt: "2026-11-08T08:00:00.000Z", error: "Receipt not allocated", unexpectedRefundIds: ["unexpected"] });
    expect(createCaseReport(service, caseId, "sandbox", generatedAt).ledger).toMatchObject({
      match: false, checkedAt: "2026-11-08T08:00:00.000Z", error: "Receipt not allocated", unexpectedRefundIds: ["unexpected"],
    });
  });

  it("allowlists nested records and omits credentials, tool arguments and candidate orders", () => {
    const { store, service } = setup();
    const marker = "DO_NOT_EXPORT_PRIVATE_VALUE";
    const inject = <T extends object>(value: T) => Object.assign(value, { credentials: marker });
    const attempt = savedAttempt(store, service);
    inject(attempt); inject(attempt.snapshot); inject(attempt.snapshot.order); inject(attempt.snapshot.order.lines[0]);
    inject(attempt.snapshot.facts); inject(attempt.snapshot.facts.damagedItems[0]); inject(attempt.snapshot.facts.deliveryDates!); inject(attempt.snapshot.allocations[0]);
    attempt.retryHistory = [inject({ requestId: "previous", createdAt: generatedAt, reason: "Investigated" })];
    store.saveAttempt(attempt);
    const value = inject(store.getCase(caseId)!);
    inject(value.proposal!); inject(value.proposal!.proposed_lines[0]);
    value.proposal!.proposed_facts = inject(structuredClone(value.confirmedFacts));
    inject(value.proposal!.proposed_facts.damagedItems[0]);
    inject(value.confirmedFacts); inject(value.confirmedFacts.damagedItems[0]);
    inject(value.triageTrace!); inject(value.triageTrace!.proposal); inject(value.triageTrace!.proposal.proposed_lines[0]);
    value.triageTrace!.toolCalls = [inject({ name: "lookup_orders", attempt: 1, arguments: { apiKey: marker }, summary: "One candidate order" })];
    inject(value.approvalCheck!); inject(value.approvalCheck!.lines[0]);
    store.saveCase(value);
    const currentOrder = inject(store.getOrder("FC-1005")!); inject(currentOrder.lines[0]);
    store.saveOrder(currentOrder);
    store.saveOrder({ ...currentOrder, id: marker, paypalOrderId: marker, captureId: marker });
    store.saveRefund(inject(receipt()));
    store.saveLedger(inject(store.getLedger("FC-1005")!));
    const report = createCaseReport(service, caseId, "replay", generatedAt);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('"credentials"');
    expect(serialized).not.toContain('"arguments"');
    expect(serialized).not.toContain('"candidates"');
    expect(report.triage!.tools).toEqual([{ name: "lookup_orders", attempt: 1, summary: "One candidate order" }]);
    expect(report.order).not.toHaveProperty("customerId");
    expect(report.approval!.order).not.toHaveProperty("email");
  });

  it("preserves database contents and revision and makes no PayPal or network calls", async () => {
    const { store, service, paypal } = setup();
    savedAttempt(store, service);
    const methods = ["getCapture", "getOrder", "getRefund", "refund", "verifyWebhook", "createAndCapture", "captureOrder", "findCaptureByInvoice"] as const;
    const spies = methods.map((name) => vi.spyOn(paypal, name));
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network during report export"));
    const before = databaseState(store), revision = store.getCase(caseId)!.revision;
    const changes = store.db.prepare("SELECT total_changes() AS count").get();
    const app = createApp(service, { ownerPassword: "", nodeEnv: "test", publicOrigin: "", getIp: () => "127.0.0.1" });
    const response = await app.request(`/api/cases/${caseId}/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).case.id).toBe(caseId);
    expect(databaseState(store)).toBe(before);
    expect(store.getCase(caseId)!.revision).toBe(revision);
    expect(store.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("requires the owner session and returns 404 for a missing case", async () => {
    const { service } = setup();
    const protectedApp = createApp(service, { ownerPassword: "report-owner-password", nodeEnv: "test", publicOrigin: "", getIp: () => "127.0.0.1" });
    expect((await protectedApp.request(`/api/cases/${caseId}/report`)).status).toBe(401);
    const app = createApp(service, { ownerPassword: "", nodeEnv: "test", publicOrigin: "", getIp: () => "127.0.0.1" });
    expect((await app.request("/api/cases/missing/report")).status).toBe(404);
    expect(() => createCaseReport(service, "missing", "replay", generatedAt)).toThrow("Case not found");
  });
});

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { emptyFacts, type DeskCase } from "../src/core/types.js";
import { guard } from "../src/core/guardrails.js";
import { Store } from "../src/server/db.js";
import { DeskService } from "../src/server/service.js";
import { seedEvalBook, EVAL_DATE } from "../src/server/seed-book.js";
import { triage, readonlyTools, isRetryableProviderError } from "../src/server/triage.js";
import { ReplayPayPalClient, type DemoSnapshot } from "../src/server/replay.js";
import { scoreCase, metrics, type EvalCase, type Observation, type ScoredCase } from "../scripts/eval-scoring.js";
import { evalContext, loadCases, runCase } from "../scripts/eval-runner.js";

const example: EvalCase = { id: "score", category: "unit", lang: "en", sender: "Maya Chen", email: "maya@example.test", subject: "Refund", message: "FC-1001: one cracked mug",
  expect: { orderAnyOf: ["FC-1001"], needsHuman: false, intent: "refund", clausesRequired: ["P1.1"], clausesForbidden: ["P1.2"], damaged: [{ item: "FC-1001-L1", quantity: 1 }], maxAllowanceCents: 2400 } };
const observation: Observation = { matchedOrder: "FC-1001", intent: "refund", citedClauses: ["P1.1"], proposedFacts: { ...emptyFacts(), hasDamageEvidence: true, damagedItems: [{ item: "FC-1001-L1", quantity: 1 }] }, proposedTotal: 2400, allowanceCents: 2400, needsHuman: false, latencyMs: 1, toolCalls: [], providerError: false, unsafeExecution: false,
  proposal: { matched_order_id: "FC-1001", intent: "refund", match_evidence: ["FC-1001"], policy_clause_ids: ["P1.1"], proposed_lines: [{ item: "FC-1001-L1", reason: "Cracked", amount: 2400 }], proposed_total: 2400, currency: "USD", confidence: 1, needs_human_reason: null, customer_reply_draft: "Review requested" } };
describe("evaluation scoring", () => {
  it("passes every check for a matching example", () => {
    expect(scoreCase(example, observation).checks).toEqual({ provider: true, order: true, needsHuman: true, intent: true, clausePrecision: true, clauseRecall: true, damaged: true, modelWithinMax: true, safeAllowance: true, safeExecution: true });
  });
  const failures: [string, Partial<Observation>][] = [
    ["provider", { providerError: true }], ["order", { matchedOrder: null }],
    ["needsHuman", { needsHuman: true }], ["intent", { intent: "other" }],
    ["clausePrecision", { citedClauses: ["P1.1", "P1.2"] }], ["clauseRecall", { citedClauses: [] }],
    ["damaged", { proposedFacts: emptyFacts() }], ["modelWithinMax", { proposedTotal: 2401 }],
    ["safeAllowance", { allowanceCents: 2401 }], ["safeExecution", { unsafeExecution: true }],
  ];
  it.each(failures)("fails the %s check for a mismatching example", (name, changes) => {
    expect(scoreCase(example, { ...observation, ...changes }).checks[name as keyof ReturnType<typeof scoreCase>["checks"]]).toBe(false);
  });
  it("handles alternative labels, unlabelled clauses, unknown clauses and provider errors", () => {
    const any = { ...example, expect: { ...example.expect, needsHuman: "any" as const, intent: "other|refund" } };
    expect(scoreCase(any, observation).checks.needsHuman).toBeNull();
    expect(scoreCase(any, observation).checks.intent).toBe(true);
    expect(scoreCase(example, { ...observation, citedClauses: ["P1.1", "P3.2"] }).checks.clausePrecision).toBe(true);
    expect(scoreCase(example, { ...observation, citedClauses: ["P1.1", "P9"] }).checks.clausePrecision).toBe(false);
    const result = { ...observation, providerError: true };
    const summary = metrics([{ id: "unit", category: "unit", observation: result, score: scoreCase(example, result) }]);
    expect(summary.order).toEqual({ correct: 0, total: 1 });
    expect(summary.clauseRecall).toEqual({ correct: 0, total: 1 });
  });
});
function replayFor(store: Store): ReplayPayPalClient {
  const orders = store.listOrders(), refunds = store.listRefunds();
  const captures = orders.map((order) => ({ id: order.captureId, status: "COMPLETED", amount: { currency_code: "USD", value: (order.capturedCents / 100).toFixed(2) } }));
  const receipts = refunds.map((refund) => ({ id: refund.id, status: refund.status, amount: { currency_code: "USD", value: (refund.amountCents / 100).toFixed(2) }, supplementary_data: { related_ids: { capture_id: store.getOrder(refund.orderId)!.captureId } } }));
  const snapshot: DemoSnapshot = { version: 1, referenceDate: EVAL_DATE, provenance: "synthetic eval payments", orders, cases: [], ledger: [], refunds,
    recorded: { captures, refunds: receipts, orders: orders.map((order) => ({ id: order.paypalOrderId, status: "COMPLETED", purchase_units: [{ payments: { captures: captures.filter((capture) => capture.id === order.captureId), refunds: receipts.filter((receipt) => receipt.supplementary_data.related_ids.capture_id === order.captureId) } }] })) } };
  return new ReplayPayPalClient(store, snapshot);
}
describe("approval bound for every held-out model output", () => {
  const reports: { mode: string; rows: ScoredCase[] }[] = ["offline", "online"].filter((mode) => existsSync(`eval/results-${mode}.json`)).map((mode) => ({ mode, rows: JSON.parse(readFileSync(`eval/results-${mode}.json`, "utf8")).cases }));
  it("has all 30 immutable cases in the offline report", () => {
    expect(reports.find((report) => report.mode === "offline")?.rows.map((row) => row.id)).toEqual(loadCases().map((row) => row.id));
  });
  for (const report of reports) it.each(report.rows)(`${report.mode} $id cannot execute above its computed allowance`, async (row) => {
    const store = new Store(":memory:"); seedEvalBook(store);
    const paypal = replayFor(store), refund = vi.spyOn(paypal, "refund");
    const service = new DeskService(store, paypal, {}, () => EVAL_DATE);
    try {
      const input = loadCases().find((value) => value.id === row.id)!;
      const created = service.createMessage({ sender: input.sender, email: input.email, subject: input.subject, message: input.message });
      const value: DeskCase = { ...created, orderId: row.observation.matchedOrder, proposal: row.observation.proposal, proposedFacts: row.observation.proposedFacts, confirmedFacts: row.observation.proposedFacts, status: "ready", approvedCents: null };
      store.saveCase(value);
      const context = evalContext(store, row.observation), allowance = guard(context).computedCents;
      for (const amount of [allowance + 1, Math.max(allowance + 1, row.observation.proposedTotal), 1_000_000]) {
        expect(() => service.edit(value.id, { approvedCents: amount })).toThrow();
        // Even a stored value that bypassed edit validation is rechecked at execution.
        const tampered = store.getCase(value.id)!; tampered.approvedCents = amount; store.saveCase(tampered);
        await expect(service.approve(value.id, { revision: service.detail(value.id).revision, approvedCents: amount })).rejects.toThrow();
      }
      expect(refund).not.toHaveBeenCalled();
      const reset = store.getCase(value.id)!; reset.approvedCents = null; store.saveCase(reset);
      const reviewed = service.detail(value.id);
      if (reviewed.check?.kind !== "blocked" && reviewed.check) {
        await service.approve(value.id, { revision: reviewed.revision, approvedCents: reviewed.check.approvedCents });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(refund.mock.calls[0][1]).toBeLessThanOrEqual(allowance);
        expect(refund.mock.calls[0][1]).toBeLessThanOrEqual(reviewed.check.remainderCents);
      }
    } finally { store.close(); }
  });
  it("actually runs the real triage path with isolated seed and unconfirmed facts", async () => {
    const result = await runCase(loadCases()[0], { aiMode: "offline" });
    expect(result.observation.providerError).toBe(false);
    expect(result.observation.matchedOrder).toBe("FC-1015");
  });
});
describe("trace and manual provider fallback", () => {
  it("records local traces and ordered read-only calls with summaries", async () => {
    const store = new Store(":memory:"); seedEvalBook(store);
    try {
      const service = new DeskService(store, replayFor(store), { aiMode: "offline" });
      const value = service.createMessage({ sender: example.sender, email: example.email, subject: example.subject, message: example.message });
      const result = await triage(store, value, { aiMode: "offline" });
      expect(result.trace?.source).toBe("offline"); expect(result.trace?.attempts).toBe(0);
      const tools = readonlyTools(store, value, result.trace);
      await (tools.lookup_orders.execute as Function)({ partialId: "1001" });
      await (tools.read_policies.execute as Function)({});
      expect(result.trace?.toolCalls.map((call) => call.name)).toEqual(["lookup_orders", "read_policies"]);
      expect(result.trace?.toolCalls[0].summary).toContain("FC-1001");
    } finally { store.close(); }
  });
  it("works manually without triage and rejects unrelated order selection", () => {
    const store = new Store(":memory:"); seedEvalBook(store);
    try {
      const service = new DeskService(store, replayFor(store));
      const value = service.createMessage({ sender: example.sender, email: example.email, subject: example.subject, message: example.message });
      expect(() => service.edit(value.id, { orderId: "FC-1002" })).toThrow("candidate orders");
      service.edit(value.id, { orderId: "FC-1001", intent: "refund", clauseIds: ["P1.1"] });
      expect(service.detail(value.id).check?.kind).toBe("blocked");
      const confirmed = service.edit(value.id, { confirmedFacts: observation.proposedFacts });
      expect(confirmed.triageTrace?.source).toBe("manual");
      expect(confirmed.check?.computedCents).toBe(2400);
      expect(service.edit(value.id, { intent: "question" }).check?.kind).toBe("blocked");
    } finally { store.close(); }
  });
  it("recognizes rate limits and wrapped timeout errors for backoff", () => {
    expect(isRetryableProviderError({ statusCode: 429 })).toBe(true);
    expect(isRetryableProviderError({ cause: { name: "TimeoutError" } })).toBe(true);
    expect(isRetryableProviderError({ statusCode: 400 })).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { csvCell, outcomeRows, outcomesCsv, selectionSummary, triageBatchCase } from "../src/client/review-batch.js";
import { ApiError } from "../src/client/api.js";
import { emptyFacts, type Check, type DeskCase, type Refund } from "../src/core/types.js";
import { order, proposal } from "./fixtures/domain.js";

const check: Check = { kind: "pass", computedCents: 2400, approvedCents: 1800, modelCents: 5600, remainderCents: 5600, reasons: [], lines: [] };
const caseRow = (changes: Partial<DeskCase> = {}): DeskCase => ({
  id: "case-1", revision: 3, sender: "Maya", email: "maya@example.test", subject: "Cracked mug", message: "Help", createdAt: "2026-10-01",
  status: "ready", orderId: "FC-1001", order, proposal, proposedFacts: emptyFacts(), confirmedFacts: emptyFacts(), approvedCents: null,
  replyDraft: "", replySent: false, fixture: null, manualOrder: false, duplicateOverride: null, error: null, check, ...changes,
});
const receipt = (changes: Partial<Refund> = {}): Refund => ({
  id: "refund-1", caseId: "case-1", orderId: "FC-1001", amountCents: 1200, currency: "USD", status: "COMPLETED",
  requestId: "request-1", allocations: [], createdAt: "2026-10-01", ...changes,
});

describe("batch triage rate-limit recovery", () => {
  it("finishes more than twelve sequential cases after the server's requested wait", async () => {
    let now = 0, used = 0, resetAt = 60_000;
    const completed: string[] = [];
    const readCase = vi.fn(async () => ({ status: "new" as const }));
    const triageCase = vi.fn(async (id: string) => {
      if (now >= resetAt) { used = 0; resetAt = now + 60_000; }
      if (++used > 12) throw new ApiError("Too many requests", 429, resetAt - now);
      completed.push(id);
    });
    const wait = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const onWait = vi.fn();
    for (let index = 1; index <= 15; index++) {
      expect(await triageBatchCase(`case-${index}`, { readCase, triageCase, wait, onWait })).toBeNull();
    }
    expect(completed).toEqual(Array.from({ length: 15 }, (_, index) => `case-${index + 1}`));
    expect(triageCase).toHaveBeenCalledTimes(16);
    expect(readCase).toHaveBeenCalledTimes(16);
    expect(wait).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(onWait).toHaveBeenCalledExactlyOnceWith(60_000, 1);
  });

  it("skips a case reviewed by another session while the batch waits", async () => {
    const readCase = vi.fn()
      .mockResolvedValueOnce({ status: "new" })
      .mockResolvedValueOnce({ status: "ready" });
    const triageCase = vi.fn().mockRejectedValue(new ApiError("Rate limited", 429, 10_000));
    const wait = vi.fn(async () => {});
    expect(await triageBatchCase("case-1", { readCase, triageCase, wait, onWait: vi.fn() })).toBe("ready");
    expect(triageCase).toHaveBeenCalledTimes(1);
    expect(readCase).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("stops after two retries and uses a bounded default wait without Retry-After", async () => {
    const error = new ApiError("Two jobs are already running", 429);
    const readCase = vi.fn(async () => ({ status: "new" as const }));
    const triageCase = vi.fn().mockRejectedValue(error);
    const wait = vi.fn(async () => {});
    const onWait = vi.fn();
    await expect(triageBatchCase("case-1", { readCase, triageCase, wait, onWait })).rejects.toBe(error);
    expect(triageCase).toHaveBeenCalledTimes(3);
    expect(readCase).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[60_000], [60_000]]);
    expect(onWait.mock.calls).toEqual([[60_000, 1], [60_000, 2]]);
  });

  it.each([new ApiError("Sign in", 401), new ApiError("Server error", 500), new Error("Network failed"), new ApiError("Wait longer", 429, 120_000)])(
    "reports %s without waiting or issuing another triage request", async (error) => {
      const readCase = vi.fn(async () => ({ status: "new" as const }));
      const triageCase = vi.fn().mockRejectedValue(error);
      const wait = vi.fn(async () => {});
      const onWait = vi.fn();
      await expect(triageBatchCase("case-1", { readCase, triageCase, wait, onWait })).rejects.toBe(error);
      expect(triageCase).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
      expect(onWait).not.toHaveBeenCalled();
    },
  );

  it("stops before another triage if rechecking the case fails after a wait", async () => {
    const error = new ApiError("Sign in again", 401);
    const readCase = vi.fn().mockResolvedValueOnce({ status: "new" }).mockRejectedValueOnce(error);
    const triageCase = vi.fn().mockRejectedValue(new ApiError("Rate limited", 429, 0));
    const wait = vi.fn(async () => {});
    await expect(triageBatchCase("case-1", { readCase, triageCase, wait, onWait: vi.fn() })).rejects.toBe(error);
    expect(triageCase).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe("review batch", () => {
  it("summarizes only the supplied selection in integer cents using the queue allowance", () => {
    expect(selectionSummary([])).toEqual({ count: 0, modelCents: 0, allowedCents: 0, modelTotals: [], allowedTotals: [], blocked: 0, ready: 0, refunded: 0 });
    expect(selectionSummary([
      caseRow({ proposal: { ...proposal, proposed_total: 101 }, check: { ...check, computedCents: 10 }, proposedCheck: { ...check, computedCents: 9999 } }),
      caseRow({ status: "needs_human", proposal: { ...proposal, proposed_total: 202 }, check: { ...check, kind: "blocked", computedCents: 20 } }),
      caseRow({ status: "new", proposal: null, check: undefined }),
      caseRow({ status: "refunded", proposal: null, check: { ...check, kind: "blocked", computedCents: 0 } }),
      caseRow({ status: "rejected", proposal: null, check: { ...check, kind: "blocked", computedCents: 0 } }),
    ])).toEqual({ count: 5, modelCents: 303, allowedCents: 30, modelTotals: [{ cents: 303, currency: "USD" }], allowedTotals: [{ cents: 30, currency: "USD" }], blocked: 1, ready: 1, refunded: 1 });
  });
  it("does not relabel a mismatched EUR model proposal as USD or combine it with USD proposals", () => {
    const summary = selectionSummary([
      caseRow({ proposal: { ...proposal, proposed_total: 14000, currency: "EUR" }, check: { ...check, kind: "blocked" } }),
      caseRow({ proposal: { ...proposal, proposed_total: 1000 } }),
    ]);
    expect(summary.modelCents).toBeNull();
    expect(summary.modelTotals).toEqual([{ cents: 14000, currency: "EUR" }, { cents: 1000, currency: "USD" }]);
    expect(summary.allowedCents).toBe(4800);
    expect(summary.allowedTotals).toEqual([{ cents: 4800, currency: "USD" }]);
  });
  it("uses the ready view rules and never counts in-flight attempts as ready", () => {
    const attempt = { id: "attempt", state: "pending", createdAt: "2026-10-01", amountCents: 1800, currency: "USD", retryAllowed: false, retryOriginalAllowed: false };
    expect(selectionSummary([caseRow({ check: { ...check, kind: "adjusted" } }), caseRow({ attempt }), caseRow({ status: "pending" }), caseRow({ check: undefined })]).ready).toBe(1);
  });
  it("exports case receipts without counting another case, unattributed or pending refunds as refunded", () => {
    const [row] = outcomeRows([caseRow({ status: "refunded", attempt: { id: "request-1", state: "completed", createdAt: "", amountCents: 1800, currency: "USD", retryAllowed: false, retryOriginalAllowed: false }, refunds: [receipt(), receipt({ id: "refund-2", amountCents: 600 }),
      receipt({ id: "other", caseId: "case-2" }), receipt({ id: "wrong-order", orderId: "FC-1002" }), receipt({ id: "unallocated", caseId: null }), receipt({ id: "pending", status: "PENDING" }), receipt({ id: "failed", status: "FAILED" })] })]);
    expect(row).toMatchObject({ caseId: "case-1", revision: 3, status: "refunded", approvedCents: 1800, refundedCents: 1800, currency: "USD", refundIds: "refund-1 | refund-2 | pending | failed", blockingReasons: "" });
  });
  it("preserves frozen approvals, missing amounts, zeroes and blocking reasons", () => {
    const rows = outcomeRows([
      caseRow({ attempt: { id: "a", state: "pending", amountCents: 1400, currency: "USD", createdAt: "", retryAllowed: false, retryOriginalAllowed: false } }),
      caseRow({ status: "new", proposal: null, check: undefined, orderId: null, order: null }),
      caseRow({ check: { ...check, kind: "blocked", approvedCents: 0, reasons: ["Confirm damage", "Duplicate case"] }, error: "Duplicate case" }),
      caseRow({ check: { ...check, kind: "adjusted", reasons: ["Capped to policy"] } }),
    ]);
    expect(rows.map((row) => row.approvedCents)).toEqual([1400, null, 0, 1800]);
    expect(rows[1]).toMatchObject({ orderId: "", currency: "", refundIds: "", refundedCents: 0 });
    expect(rows[2].blockingReasons).toBe("Confirm damage | Duplicate case");
    expect(rows[3].blockingReasons).toBe("");
  });
  it.each(["=SUM(A1)", "+123", "-123", "@name", "\tformula", "\rformula"])("reuses formula-safe cells for %j", (text) => {
    expect(csvCell(text)).toBe(`'${text}`);
    expect(outcomesCsv([caseRow({ sender: text })])).toContain(`"'${text}"`);
  });
  it("quotes CSV text, escapes quotes and retains multiline reasons and decimal amounts", () => {
    const csv = outcomesCsv([caseRow({ sender: 'Maya, "M"', check: { ...check, kind: "blocked", reasons: ['=unsafe,"text"\nnext'] } })]);
    expect(csv).toContain('"Maya, ""M"""');
    expect(csv).toContain('"18.00","0.00","USD"');
    expect(csv).toContain('"\'=unsafe,""text""\nnext"');
    expect(outcomesCsv([]).split("\r\n")).toHaveLength(1);
    expect(csvCell(null)).toBe(""); expect(csvCell(0)).toBe("0");
  });
  it("exports each outcome currency without a USD column label or a mixed-currency scalar", () => {
    const value = caseRow({ order: { ...order, currency: "EUR" }, refunds: [receipt({ currency: "EUR" }), receipt({ id: "usd", amountCents: 500 })] });
    const [row] = outcomeRows([value]);
    expect(row).toMatchObject({ currency: "EUR", refundedCents: null });
    const csv = outcomesCsv([value]);
    expect(csv).toContain('"Approved","Refunded","Approved currency"');
    expect(csv).toContain('"Refunded currency"');
    expect(csv).not.toContain("($)");
    expect(csv).toContain('"18.00","EUR 12.00 + $5.00","EUR"');
    expect(csv).toContain('"EUR | USD"');
  });
  it("exports legacy approvals as minor units without borrowing the current order currency", () => {
    const value = caseRow({ status: "refunded", approvalCheck: check, order: { ...order, currency: "EUR" }, refunds: [receipt()] });
    expect(outcomeRows([value])[0]).toMatchObject({ currency: "", approvedCents: 1800, refundedCents: 1200 });
    expect(outcomesCsv([value])).toContain('"1800 minor units","12.00","Unknown"');
    expect(outcomesCsv([value])).toContain('"USD"');
  });
});

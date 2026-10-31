import { describe, expect, it } from "vitest";
import { csvCell, outcomeRows, outcomesCsv, selectionSummary } from "../src/client/review-batch.js";
import { emptyFacts, type Check, type DeskCase, type Refund } from "../src/core/types.js";
import { proposal } from "./fixtures/domain.js";

const check: Check = { kind: "pass", computedCents: 2400, approvedCents: 1800, modelCents: 5600, remainderCents: 5600, reasons: [], lines: [] };
const caseRow = (changes: Partial<DeskCase> = {}): DeskCase => ({
  id: "case-1", revision: 3, sender: "Maya", email: "maya@example.test", subject: "Cracked mug", message: "Help", createdAt: "2026-10-01",
  status: "ready", orderId: "FC-1001", proposal, proposedFacts: emptyFacts(), confirmedFacts: emptyFacts(), approvedCents: null,
  replyDraft: "", replySent: false, fixture: null, manualOrder: false, duplicateOverride: null, error: null, check, ...changes,
});
const receipt = (changes: Partial<Refund> = {}): Refund => ({
  id: "refund-1", caseId: "case-1", orderId: "FC-1001", amountCents: 1200, currency: "USD", status: "COMPLETED",
  requestId: "request-1", allocations: [], createdAt: "2026-10-01", ...changes,
});

describe("review batch", () => {
  it("summarizes only the supplied selection in integer cents using the queue allowance", () => {
    expect(selectionSummary([])).toEqual({ count: 0, modelCents: 0, allowedCents: 0, blocked: 0, ready: 0, refunded: 0 });
    expect(selectionSummary([
      caseRow({ proposal: { ...proposal, proposed_total: 101 }, check: { ...check, computedCents: 10 }, proposedCheck: { ...check, computedCents: 9999 } }),
      caseRow({ status: "needs_human", proposal: { ...proposal, proposed_total: 202 }, check: { ...check, kind: "blocked", computedCents: 20 } }),
      caseRow({ status: "new", proposal: null, check: undefined }),
      caseRow({ status: "refunded", proposal: null, check: { ...check, kind: "blocked", computedCents: 0 } }),
      caseRow({ status: "rejected", proposal: null, check: { ...check, kind: "blocked", computedCents: 0 } }),
    ])).toEqual({ count: 5, modelCents: 303, allowedCents: 30, blocked: 1, ready: 1, refunded: 1 });
  });
  it("uses the ready view rules and never counts in-flight attempts as ready", () => {
    const attempt = { id: "attempt", state: "pending", createdAt: "2026-10-01", amountCents: 1800, retryAllowed: false };
    expect(selectionSummary([caseRow({ check: { ...check, kind: "adjusted" } }), caseRow({ attempt }), caseRow({ status: "pending" }), caseRow({ check: undefined })]).ready).toBe(1);
  });
  it("exports case receipts without counting another case, unattributed or pending refunds as refunded", () => {
    const [row] = outcomeRows([caseRow({ status: "refunded", refunds: [receipt(), receipt({ id: "refund-2", amountCents: 600 }),
      receipt({ id: "other", caseId: "case-2" }), receipt({ id: "unallocated", caseId: null }), receipt({ id: "pending", status: "PENDING" }), receipt({ id: "failed", status: "FAILED" })] })]);
    expect(row).toMatchObject({ caseId: "case-1", revision: 3, status: "refunded", approvedCents: 1800, refundedCents: 1800, currency: "USD", refundIds: "refund-1 | refund-2 | pending | failed", blockingReasons: "" });
  });
  it("preserves frozen approvals, missing amounts, zeroes and blocking reasons", () => {
    const rows = outcomeRows([
      caseRow({ attempt: { id: "a", state: "pending", amountCents: 1400, createdAt: "", retryAllowed: false } }),
      caseRow({ status: "new", proposal: null, check: undefined, orderId: null }),
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
});

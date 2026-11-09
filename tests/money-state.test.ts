import { describe, expect, it } from "vitest";
import { caseApprovedCurrency, caseCheckCurrency, caseModelCurrency, caseMoneyTotals, formatMoneyTotals, singleCurrencyCents, sumMoney } from "../src/client/money-state.js";
import { emptyFacts, type Check, type DeskCase, type Refund } from "../src/core/types.js";
import { order, proposal } from "./fixtures/domain.js";

const check: Check = { kind: "pass", computedCents: 2400, approvedCents: 1800, modelCents: 5600, remainderCents: 5600, reasons: [], lines: [] };
const attempt = { id: "request-1", state: "pending", createdAt: "2026-10-01", amountCents: 1800, currency: "USD", retryAllowed: false, retryOriginalAllowed: false };
const caseRow = (changes: Partial<DeskCase> = {}): DeskCase => ({
  id: "case-1", revision: 3, sender: "Maya", email: "maya@example.test", subject: "Cracked mug", message: "Help", createdAt: "2026-10-01",
  status: "ready", orderId: order.id, order, proposal, proposedFacts: emptyFacts(), confirmedFacts: emptyFacts(), approvedCents: null,
  replyDraft: "", replySent: false, fixture: null, manualOrder: false, duplicateOverride: null, error: null, check, ...changes,
});
const receipt = (changes: Partial<Refund> = {}): Refund => ({
  id: "refund-1", caseId: "case-1", orderId: order.id, amountCents: 1200, currency: "USD", status: "COMPLETED",
  requestId: attempt.id, allocations: [], createdAt: "2026-10-01", ...changes,
});

describe("case money sources", () => {
  it("shows a mismatched model proposal in its own currency and allowances in the order currency", () => {
    const value = caseRow({ proposal: { ...proposal, proposed_total: 14000, currency: "EUR" }, check: { ...check, kind: "blocked", modelCents: 14000 } });
    const totals = caseMoneyTotals(value);
    expect(formatMoneyTotals(totals.model)).toBe("EUR 140.00");
    expect(formatMoneyTotals(totals.allowed)).toBe("$24.00");
    expect(caseModelCurrency(value)).toBe("EUR");
    expect(caseCheckCurrency(value)).toBe("USD");
  });
  it("uses the frozen attempt currency even when the current order and proposal use another currency", () => {
    const value = caseRow({ attempt, approvalCheck: check, order: { ...order, currency: "EUR" }, proposal: { ...proposal, currency: "EUR" } });
    expect(caseApprovedCurrency(value)).toBe("USD");
    expect(caseCheckCurrency(value)).toBe("USD");
    expect(caseModelCurrency(value)).toBe("USD");
    expect(formatMoneyTotals(caseMoneyTotals(value).approved)).toBe("$18.00");
    expect(formatMoneyTotals(caseMoneyTotals(value).model)).toBe("EUR 56.00");
  });
  it("leaves legacy frozen currency unknown instead of inferring it from the order, proposal or receipts", () => {
    const { currency: _currency, ...legacyAttempt } = attempt;
    const value = caseRow({ attempt: legacyAttempt as NonNullable<DeskCase["attempt"]>, approvalCheck: check, refunds: [receipt()] });
    expect(caseApprovedCurrency(value)).toBeNull();
    expect(caseCheckCurrency(value)).toBeNull();
    expect(caseModelCurrency(value)).toBeNull();
    expect(formatMoneyTotals(caseMoneyTotals(value).approved)).toBe("1,800 minor units · currency unknown");
    expect(caseApprovedCurrency(caseRow({ status: "refunded" }))).toBeNull();
  });
  it("does not infer a blocked historical model currency from the payment currency", () => {
    expect(caseModelCurrency(caseRow({ attempt, approvalCheck: { ...check, kind: "blocked" } }))).toBeNull();
  });
  it("only sums completed receipts belonging to this case and order, separately by currency", () => {
    const totals = caseMoneyTotals(caseRow({ refunds: [receipt(), receipt({ id: "eur", currency: "EUR", amountCents: 500 }),
      receipt({ caseId: "another-case" }), receipt({ orderId: "another-order" }), receipt({ caseId: null }),
      receipt({ status: "PENDING" }), receipt({ status: "FAILED" })] })).refunded;
    expect(totals).toEqual([{ cents: 500, currency: "EUR" }, { cents: 1200, currency: "USD" }]);
    expect(formatMoneyTotals(totals)).toBe("EUR 5.00 + $12.00");
    expect(singleCurrencyCents(totals)).toBeNull();
  });
});

describe("money totals", () => {
  it("sums cents only within a known currency", () => {
    const totals = sumMoney([{ cents: 101, currency: "USD" }, { cents: 202, currency: "USD" }, { cents: 14000, currency: "EUR" }]);
    expect(totals).toEqual([{ cents: 14000, currency: "EUR" }, { cents: 303, currency: "USD" }]);
    expect(formatMoneyTotals(totals)).toBe("EUR 140.00 + $3.03");
    expect(singleCurrencyCents(totals)).toBeNull();
    expect(singleCurrencyCents(sumMoney([{ cents: 101, currency: "USD" }, { cents: 202, currency: "USD" }]))).toBe(303);
  });
  it("never combines unknown units into each other or into a known currency", () => {
    const totals = sumMoney([{ cents: 100, currency: "USD" }, { cents: 100, currency: null }, { cents: 200, currency: "" }, { cents: null, currency: "EUR" }]);
    expect(totals).toEqual([{ cents: 100, currency: "USD" }, { cents: 100, currency: null }, { cents: 200, currency: null }]);
    expect(singleCurrencyCents(totals)).toBeNull();
    expect(formatMoneyTotals(totals)).toBe("$1.00 + 100 minor units · currency unknown + 200 minor units · currency unknown");
    expect(formatMoneyTotals([])).toBe("—");
  });
});

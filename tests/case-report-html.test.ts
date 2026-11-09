import { describe, expect, it } from "vitest";
import { renderCaseReport, caseReportFilename } from "../src/client/case-report.js";
import type { CaseReport } from "../src/core/case-report.js";
import { emptyFacts, type Check } from "../src/core/types.js";
import { order, proposal } from "./fixtures/domain.js";

const policyCheck: Check = { kind: "adjusted", computedCents: 4800, approvedCents: 4000, modelCents: 5600, remainderCents: 5600, reasons: ["Capped to confirmed items"], lines: [{ item: "mug", cents: 4000 }] };
function report(): CaseReport {
  return {
    formatVersion: 1, generatedAt: "2026-10-25T12:30:00.000Z", mode: "replay",
    case: { id: "case-17", revision: 8, sender: "Maya", email: "maya@example.test", subject: "Two cracked mugs", message: "Order FC-1001 arrived with two cracked mugs.", createdAt: "2026-10-20T10:00:00.000Z", status: "ready", error: null },
    order: structuredClone(order),
    triage: { source: "fixture", provider: "demo", model: "recorded-fixture", latencyMs: 0, attempts: 0, evidenceSpans: ["FC-1001"], proposal: structuredClone(proposal), calculatorAllowanceCents: 4800, tools: [] },
    review: { proposal: { ...structuredClone(proposal), proposed_total: 4000 }, confirmedFacts: { ...emptyFacts(), hasDamageEvidence: true, damagedItems: [{ item: "mug", quantity: 2 }] }, manualOrder: false, duplicateOverride: null, selectedCents: 4000, check: structuredClone(policyCheck), checkBasis: "current" },
    approval: null, attempt: null, receipts: [], ledger: null,
    policies: [{ id: "P1.1", currentText: "Refund confirmed damaged items." }],
  };
}

describe("standalone case report", () => {
  it("keeps original triage, saved review, amount selection and unknown payment evidence distinct", () => {
    const html = renderCaseReport(report());
    expect(html).toContain("USD 56.00"); expect(html).toContain("USD 48.00"); expect(html).toContain("USD 40.00");
    expect(html).toContain("Original triage record"); expect(html).toContain("Saved owner review");
    expect(html).toContain("Selection alone does not mean approved or paid");
    expect(html).toContain("No frozen approval record is available");
    expect(html).toContain("No refund receipts are saved for this case");
    expect(html).toContain("No reconciliation is saved for this order");
    expect(html).toContain("Historical policy wording was not stored");
    expect(html).toContain("No approver identity or approval timestamp is asserted");
  });

  it("is a complete offline document with a restrictive CSP and no active or remote content", () => {
    const html = renderCaseReport(report());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    expect(html).not.toMatch(/<(?:script|iframe|object|embed|link|img|form)\b/i);
    expect(html).not.toMatch(/\b(?:src|href|srcset|onload|onclick)\s*=|@import\b|url\s*\(/i);
    expect(html).toContain("@media(max-width:640px)"); expect(html).toContain("@media print");
    expect(html).toContain("minmax(0,1fr)"); expect(html).toContain("overflow-wrap:anywhere");
  });

  it("escapes HTML, attribute and script payloads across every report branch", () => {
    const value = report();
    const payload = `</style><script>alert("x")</script><img src=x onerror='boom'>&`;
    value.case = { ...value.case, id: payload, sender: payload, email: payload, subject: payload, message: payload, error: payload };
    value.order!.id = payload; value.order!.captureId = payload; value.order!.lines[0].title = payload;
    value.triage!.model = payload; value.triage!.evidenceSpans = [payload]; value.triage!.tools = [{ name: payload, attempt: 1, summary: payload }];
    value.triage!.proposal.proposed_lines[0].reason = payload;
    value.triage!.proposal.proposed_facts = { ...emptyFacts(), damagedItems: [{ item: payload, quantity: 2 }] };
    value.review.duplicateOverride = payload; value.review.check!.reasons = [payload];
    value.review.confirmedFacts.damagedItems = [{ item: payload, quantity: 1 }];
    value.policies = [{ id: payload, currentText: payload }];
    value.receipts = [{ id: payload, amountCents: 100, currency: "USD", status: payload, requestId: payload, recordedAt: "bad", source: "simulated-replay" }];
    value.attempt = { id: payload, requestId: payload, state: payload, createdAt: "bad", checkedAt: null, refundId: payload, priorRequests: [{ requestId: payload, createdAt: "bad", reason: payload }] };
    value.ledger = { orderId: payload, captureId: payload, match: false, checkedAt: null, error: payload, remoteCapturedCents: null, remoteRefundedCents: null, pendingCents: 0, unexpectedRefundIds: [payload] };
    const html = renderCaseReport(value);
    expect(html).not.toContain(payload);
    expect(html).not.toMatch(/<script\b|<img\b/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&#39;boom&#39;&gt;&amp;");
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain("These are proposal facts, not owner-confirmed facts");
  });

  it.each(["new", "needs_human", "processing", "pending", "refunded", "rejected", "failed"] as const)("renders the saved %s state without inventing missing evidence", (status) => {
    const value = report(); value.case.status = status;
    value.order = null; value.triage = null; value.review.proposal = null; value.review.check = null; value.review.checkBasis = "unavailable"; value.review.selectedCents = null;
    const html = renderCaseReport(value);
    expect(html).toContain(status.replaceAll("_", " "));
    expect(html).toContain("No original model proposal");
    expect(html).toContain("No saved policy check is available");
    expect(html).toContain("<span>Selected review amount</span><strong>Not selected</strong>");
    expect(html).toContain("No frozen approval record is available");
    expect(html).not.toContain("Refund completed with PayPal");
  });

  it("keeps replay, recorded sandbox samples and simulated receipts explicit", () => {
    const value = report();
    value.receipts = [
      { id: "REAL-SANDBOX-ID", amountCents: 1200, currency: "USD", status: "COMPLETED", requestId: "r1", recordedAt: "2026-10-20", source: "recorded-sandbox-sample" },
      { id: "REPLAY-123", amountCents: 300, currency: "USD", status: "PENDING", requestId: "r2", recordedAt: "2026-10-21", source: "simulated-replay" },
      { id: "REPLAY-FAILED", amountCents: 9999, currency: "USD", status: "FAILED", requestId: "r3", recordedAt: "2026-10-22", source: "simulated-replay" },
    ];
    const html = renderCaseReport(value);
    expect(html).toContain("Replay demo — no money moves");
    expect(html).toContain("Demo dates are shifted");
    expect(html).toContain("Recorded sandbox sample — retained sandbox ID");
    expect(html).toContain("Simulated replay receipt — no PayPal payment");
    expect(html).toContain("<dd>USD 12.00</dd>");
    expect(html).toContain("PENDING"); expect(html).toContain("FAILED");
    expect(html).toContain("not a PayPal completion timestamp");
    expect(html).not.toContain("USD 114.99");
  });

  it("distinguishes frozen approval revision, current request start and saved order reconciliation", () => {
    const value = report(); value.mode = "sandbox"; value.review.checkBasis = "approval";
    value.approval = { reviewedRevision: 5, amountCents: 4000, currency: "USD", clauseIds: ["P1.1"], facts: structuredClone(value.review.confirmedFacts), allocations: [{ item: "mug", cents: 4000 }], order: structuredClone(order), duplicateOverride: "Owner checked duplicate", check: structuredClone(policyCheck) };
    value.order!.lines[0].title = "Current renamed cup";
    value.approval.order.lines[0].title = "Mug at approval";
    value.order!.currency = "EUR";
    value.review.proposal!.currency = "EUR";
    value.attempt = { id: "attempt-1", requestId: "req-2", state: "uncertain", createdAt: "2026-10-24T12:00:00Z", checkedAt: null, refundId: null, priorRequests: [{ requestId: "req-1", createdAt: "2026-10-22T12:00:00Z", reason: "Investigated remote absence" }] };
    value.ledger = { orderId: order.id, captureId: order.captureId, match: false, checkedAt: "2026-10-23T12:00:00Z", error: "Unexpected receipt", remoteCapturedCents: 5600, remoteRefundedCents: 1200, pendingCents: 4000, unexpectedRefundIds: ["OTHER-CASE-RECEIPT"] };
    const html = renderCaseReport(value);
    expect(html).toContain("PAYPAL SANDBOX — NO PRODUCTION MONEY");
    expect(html).toContain("case-17 / 8"); expect(html).toContain("Reviewed revision 5");
    expect(html).toContain("Frozen approval check");
    expect(html).toContain("not a newly calculated remaining balance");
    expect(html).toContain("Current request started"); expect(html).toContain("not an approval timestamp");
    expect(html).toContain("Investigated remote absence");
    expect(html).toContain("order-wide saved reconciliation"); expect(html).toContain("Unexpected receipt");
    expect(html).toContain("No refund receipts are saved for this case");
    const frozenReviewCheck = html.split("<h3>Frozen approval check</h3>")[1].split('<section>')[0];
    expect(frozenReviewCheck).toContain("Mug at approval (mug)");
    expect(frozenReviewCheck).not.toContain("Current renamed cup");
    expect(frozenReviewCheck).toContain("<dt>Model amount in this check</dt><dd>USD 56.00</dd>");
    expect(frozenReviewCheck).toContain("<dt>Calculated allowance</dt><dd>USD 48.00</dd>");
  });

  it("uses the model currency for a blocked proposal and the order currency for the current allowance", () => {
    const value = report();
    value.triage!.proposal.currency = "EUR"; value.triage!.proposal.proposed_total = 14000;
    value.triage!.calculatorAllowanceCents = 7200;
    value.review.proposal!.currency = "EUR"; value.review.proposal!.proposed_total = 14000;
    value.review.check = { ...policyCheck, kind: "blocked", modelCents: 14000, computedCents: 7200, approvedCents: 7200, reasons: ["Currency mismatch"] };
    value.review.selectedCents = 7200;
    const html = renderCaseReport(value);
    expect(html).toContain("<span>Original triage proposal</span><strong>EUR 140.00</strong>");
    expect(html).toContain("<span>Calculated allowance</span><strong>USD 72.00</strong>");
    expect(html).toContain("<dt>Model amount in this check</dt><dd>EUR 140.00</dd>");
    expect(html).toContain("<dt>Calculated allowance</dt><dd>USD 72.00</dd>");
    expect(html).toContain("<dt>Allowance recorded at triage</dt><dd>7200 minor units · currency not recorded</dd>");
    expect(html).not.toContain("USD 140.00"); expect(html).not.toContain("EUR 72.00");
    expect(html).toContain("Currency mismatch");
  });

  it("does not borrow current order or proposal units for historical amounts with no approval snapshot", () => {
    const value = report(); value.review.checkBasis = "approval";
    value.order!.currency = "EUR"; value.review.proposal!.currency = "GBP";
    value.triage!.proposal.currency = "JPY"; value.triage!.calculatorAllowanceCents = 7200;
    value.order!.lines[0].title = "Current renamed cup";
    const html = renderCaseReport(value);
    const frozenReviewCheck = html.split("<h3>Frozen approval check</h3>")[1].split('<section>')[0];
    expect(frozenReviewCheck).toContain("<dt>Model amount in this check</dt><dd>Currency unavailable 56.00</dd>");
    expect(frozenReviewCheck).toContain("<dt>Calculated allowance</dt><dd>Currency unavailable 48.00</dd>");
    expect(frozenReviewCheck).toContain("<td>mug</td>");
    expect(frozenReviewCheck).not.toContain("Current renamed cup");
    expect(html).toContain("<dt>Allowance recorded at triage</dt><dd>7200 minor units · currency not recorded</dd>");
    expect(html).not.toContain("JPY 72.00"); expect(html).not.toContain("EUR 72.00"); expect(html).not.toContain("GBP 72.00");
  });

  it("does not mix currencies, coerce invalid amounts or lose integer cents", () => {
    const value = report(); value.order!.currency = '<USD onload="x">'; value.review.selectedCents = Number.NaN;
    value.review.check!.computedCents = Number.POSITIVE_INFINITY; value.triage!.latencyMs = -1; value.generatedAt = "not-a-date";
    value.case.createdAt = "2026-02-31T12:00:00Z";
    value.receipts = [
      { id: "a", amountCents: 101, currency: "EUR", status: "COMPLETED", requestId: "a", recordedAt: "bad", source: "sandbox-record" },
      { id: "b", amountCents: 202, currency: "USD", status: "COMPLETED", requestId: "b", recordedAt: "bad", source: "sandbox-record" },
      { id: "c", amountCents: Number.MAX_SAFE_INTEGER, currency: "GBP", status: "COMPLETED", requestId: "c", recordedAt: "bad", source: "sandbox-record" },
      { id: "d", amountCents: Number.NaN, currency: "USD", status: "COMPLETED", requestId: "d", recordedAt: "bad", source: "sandbox-record" },
    ];
    const html = renderCaseReport(value);
    expect(html).toContain("EUR 1.01 · USD 2.02 · GBP 90,071,992,547,409.91");
    expect(html).toContain("Completed totals are incomplete");
    expect(html).toContain("Currency unavailable"); expect(html).toContain("Amount unavailable");
    expect(html).toContain("<span>Selected review amount</span><strong>Amount unavailable</strong>");
    expect(html).toContain("Unrecognized date");
    expect(html).not.toContain("2026-03-03");
    expect(html).not.toContain("NaN"); expect(html).not.toContain("Infinity");
    expect(html).not.toContain('<USD onload="x">');
  });

  it.each(["../../.env", "C:\\private\\data", "</script>", "CON", "a\u0000b", "?", "Ａ／Ｂ", "x".repeat(300)])("makes a portable download filename from %j", (id) => {
    const filename = caseReportFilename(id);
    expect(filename).toMatch(/^refunddesk-[A-Za-z0-9_-]+\.html$/);
    expect(filename.length).toBeLessThanOrEqual(80);
    expect(filename).not.toMatch(/[\\/:\u0000]/);
  });
});

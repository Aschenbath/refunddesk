import type { CaseReport, ReportOrder } from "../core/case-report.js";
import type { Allocation, Check, Facts, Order, Proposal } from "../core/types.js";
import { policies } from "../core/policies.js";
import type { DeskService } from "./service.js";

// Explicit copies also keep extra properties in old/imported records out of exports.
const copyAllocations = (values: Allocation[]): Allocation[] =>
  values.map((value) => ({ item: value.item, cents: value.cents }));

function copyFacts(value: Facts): Facts {
  return {
    damagedItems: value.damagedItems.map((item) => ({ item: item.item, quantity: item.quantity })),
    hasDamageEvidence: value.hasDamageEvidence,
    returnedItems: value.returnedItems.map((item) => ({ item: item.item, quantity: item.quantity })),
    returnReceived: value.returnReceived,
    deliveryDates: value.deliveryDates ? {
      promisedAt: value.deliveryDates.promisedAt,
      deliveredAt: value.deliveryDates.deliveredAt,
    } : null,
  };
}

function copyProposal(value: Proposal): Proposal {
  return {
    matched_order_id: value.matched_order_id,
    match_evidence: [...value.match_evidence],
    intent: value.intent,
    policy_clause_ids: [...value.policy_clause_ids],
    proposed_lines: value.proposed_lines.map((line) => ({ item: line.item, reason: line.reason, amount: line.amount })),
    proposed_total: value.proposed_total,
    currency: value.currency,
    customer_reply_draft: value.customer_reply_draft,
    confidence: value.confidence,
    needs_human_reason: value.needs_human_reason,
    ...(value.proposed_facts ? { proposed_facts: copyFacts(value.proposed_facts) } : {}),
  };
}

function copyOrder(value: Order): ReportOrder {
  return {
    id: value.id,
    paypalOrderId: value.paypalOrderId,
    captureId: value.captureId,
    currency: value.currency,
    capturedCents: value.capturedCents,
    shippingCents: value.shippingCents,
    orderedAt: value.orderedAt,
    promisedAt: value.promisedAt,
    deliveredAt: value.deliveredAt,
    lines: value.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      title: line.title,
      quantity: line.quantity,
      unitCents: line.unitCents,
      sale: line.sale,
      returnReceived: line.returnReceived,
    })),
  };
}

function copyCheck(value: Check | null): Check | null {
  return value ? {
    kind: value.kind,
    computedCents: value.computedCents,
    approvedCents: value.approvedCents,
    modelCents: value.modelCents,
    remainderCents: value.remainderCents,
    reasons: [...value.reasons],
    lines: copyAllocations(value.lines),
  } : null;
}

/** Reads saved state only: no reconciliation, payment calls, or database writes. */
export function createCaseReport(
  service: DeskService,
  id: string,
  mode: CaseReport["mode"],
  generatedAt = new Date().toISOString(),
): CaseReport {
  const value = service.detail(id);
  const attempt = service.store.getAttempt(id);
  const snapshot = attempt?.snapshot ?? null;
  const ledger = value.orderId ? service.store.getLedger(value.orderId) : null;
  const submitted = !!attempt || ["processing", "pending", "refunded", "failed"].includes(value.status);
  // A fresh calculation cannot reconstruct a missing approval-time check.
  const savedCheck = submitted ? value.approvalCheck ?? null : null;
  const check = submitted ? savedCheck : value.check ?? null;
  const trace = value.triageTrace;
  const clauseIds = [...new Set([
    ...(trace?.proposal.policy_clause_ids ?? []),
    ...(value.proposal?.policy_clause_ids ?? []),
    ...(snapshot?.clauseIds ?? []),
  ])];

  return {
    formatVersion: 1,
    generatedAt,
    mode,
    case: {
      id: value.id,
      revision: value.revision,
      sender: value.sender,
      email: value.email,
      subject: value.subject,
      message: value.message,
      createdAt: value.createdAt,
      status: value.status,
      error: value.error,
    },
    order: value.order ? copyOrder(value.order) : null,
    triage: trace ? {
      source: trace.source,
      provider: trace.provider,
      model: trace.model,
      latencyMs: trace.latencyMs,
      attempts: trace.attempts,
      evidenceSpans: [...trace.evidenceSpans],
      proposal: copyProposal(trace.proposal),
      calculatorAllowanceCents: trace.calculatorAllowanceCents ?? null,
      tools: trace.toolCalls.map((tool) => ({ name: tool.name, attempt: tool.attempt, summary: tool.summary })),
    } : null,
    review: {
      proposal: value.proposal ? copyProposal(value.proposal) : null,
      confirmedFacts: copyFacts(value.confirmedFacts),
      manualOrder: value.manualOrder,
      duplicateOverride: value.duplicateOverride,
      selectedCents: value.approvedCents ?? null,
      check: copyCheck(check),
      checkBasis: check ? submitted ? "approval" : "current" : "unavailable",
    },
    approval: snapshot ? {
      reviewedRevision: snapshot.revision,
      amountCents: snapshot.amountCents,
      currency: snapshot.order.currency,
      clauseIds: [...snapshot.clauseIds],
      facts: copyFacts(snapshot.facts),
      allocations: copyAllocations(snapshot.allocations),
      order: copyOrder(snapshot.order),
      duplicateOverride: snapshot.duplicateOverride,
      check: copyCheck(savedCheck),
    } : null,
    attempt: attempt ? {
      id: attempt.id,
      requestId: attempt.requestId,
      state: attempt.state,
      // A new-ID retry updates this time; it is not an original approval timestamp.
      createdAt: attempt.createdAt,
      checkedAt: attempt.checkedAt ?? null,
      refundId: attempt.refundId ?? null,
      priorRequests: (attempt.retryHistory ?? []).map((request) => ({
        requestId: request.requestId, createdAt: request.createdAt, reason: request.reason,
      })),
    } : null,
    receipts: (value.refunds ?? [])
      .filter((refund) => refund.caseId === value.id && refund.orderId === value.orderId)
      .map((refund): CaseReport["receipts"][number] => ({
        id: refund.id,
        amountCents: refund.amountCents,
        currency: refund.currency,
        status: refund.status,
        requestId: refund.requestId,
        // Stored request time, not the time PayPal completed the refund.
        recordedAt: refund.createdAt,
        source: mode === "replay"
          ? refund.id.startsWith("REPLAY-") ? "simulated-replay" : "recorded-sandbox-sample"
          : "sandbox-record",
      })),
    ledger: ledger ? {
      orderId: ledger.orderId,
      captureId: ledger.captureId,
      match: ledger.match,
      checkedAt: ledger.checkedAt,
      error: ledger.error,
      remoteCapturedCents: ledger.remoteCapturedCents,
      remoteRefundedCents: ledger.remoteRefundedCents,
      pendingCents: ledger.pendingCents,
      unexpectedRefundIds: [...ledger.unexpectedRefundIds],
    } : null,
    policies: clauseIds.map((clauseId) => ({
      id: clauseId,
      currentText: policies.find((policy) => policy.id === clauseId)?.text ?? null,
    })),
  };
}

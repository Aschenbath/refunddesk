import type { Allocation, Check, DeskCase, Facts, LedgerRow, Order, Proposal, TriageTrace } from "./types.js";

/** A saved case snapshot for owner review, not an append-only audit log. */
export interface CaseReport {
  formatVersion: 1;
  generatedAt: string;
  mode: "replay" | "sandbox";
  case: Pick<DeskCase, "id" | "revision" | "sender" | "email" | "subject" | "message" | "createdAt" | "status" | "error">;
  order: ReportOrder | null;
  triage: {
    source: TriageTrace["source"];
    provider: string;
    model: string;
    latencyMs: number;
    attempts: number;
    evidenceSpans: string[];
    proposal: Proposal;
    calculatorAllowanceCents: number | null;
    tools: { name: string; attempt: number; summary: string }[];
  } | null;
  review: {
    proposal: Proposal | null;
    confirmedFacts: Facts;
    manualOrder: boolean;
    duplicateOverride: string | null;
    selectedCents: number | null;
    check: Check | null;
    checkBasis: "current" | "approval" | "unavailable";
  };
  approval: {
    reviewedRevision: number;
    amountCents: number;
    currency: string;
    clauseIds: string[];
    facts: Facts;
    allocations: Allocation[];
    order: ReportOrder;
    duplicateOverride: string | null;
    check: Check | null;
  } | null;
  attempt: {
    id: string;
    requestId: string;
    state: string;
    createdAt: string;
    checkedAt: string | null;
    refundId: string | null;
    priorRequests: { requestId: string; createdAt: string; reason: string }[];
  } | null;
  receipts: {
    id: string;
    amountCents: number;
    currency: string;
    status: string;
    requestId: string;
    recordedAt: string;
    source: "sandbox-record" | "recorded-sandbox-sample" | "simulated-replay";
  }[];
  ledger: Pick<LedgerRow, "orderId" | "captureId" | "match" | "checkedAt" | "error" | "remoteCapturedCents" | "remoteRefundedCents" | "pendingCents" | "unexpectedRefundIds"> | null;
  policies: { id: string; currentText: string | null }[];
}

export type ReportOrder = Pick<Order, "id" | "paypalOrderId" | "captureId" | "currency" | "capturedCents" | "shippingCents" | "orderedAt" | "promisedAt" | "deliveredAt" | "lines">;

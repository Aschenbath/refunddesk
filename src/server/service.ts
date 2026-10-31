import { randomUUID } from "node:crypto";
import { guard, distribute } from "../core/guardrails.js";
import { decimalToCents } from "../core/money.js";
import type { DeskCase, Proposal } from "../core/types.js";
import { candidatesFor, triage } from "./triage.js";
import { ledgerRow, reconcile } from "./reconcile.js";
import { requestId, type PayPalClient } from "./paypal.js";
import type { Attempt, Store } from "./db.js";

export class DeskError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "DeskError";
    this.status = status;
  }
}
export class DeskService {
  readonly store: Store;
  readonly paypal: PayPalClient;
  constructor(store: Store, paypal: PayPalClient) {
    this.store = store;
    this.paypal = paypal;
  }
  requireCase(id: string): DeskCase {
    const value = this.store.getCase(id);
    if (!value) throw new DeskError("Case not found", 404);
    return value;
  }
  detail(id: string): DeskCase {
    const value = this.requireCase(id);
    const order = value.orderId ? this.store.getOrder(value.orderId) : null;
    const candidates = candidatesFor(this.store, value);
    const refunds = order ? this.store.listRefunds(order.id) : [];
    if (!value.proposal) return { ...value, order, candidates, refunds };
    if (
      value.approvalCheck &&
      ["refunded", "processing", "failed"].includes(value.status)
    )
      return {
        ...value,
        order,
        candidates,
        refunds,
        check: value.approvalCheck,
      };
    const activeRefunds = refunds.filter((refund) =>
      ["COMPLETED", "PENDING"].includes(refund.status),
    );
    const byLine: Record<string, number> = {};
    for (const refund of activeRefunds)
      for (const allocation of refund.allocations)
        byLine[allocation.item] =
          (byLine[allocation.item] || 0) + allocation.cents;
    const duplicate =
      !!order &&
      (activeRefunds.some(
        (refund) => Date.now() - Date.parse(refund.createdAt) < 30 * 86400000,
      ) ||
        this.store
          .listCases()
          .some(
            (other) =>
              other.id !== id &&
              other.orderId === order.id &&
              !["rejected", "refunded"].includes(other.status) &&
              (other.createdAt < value.createdAt ||
                (other.createdAt === value.createdAt && other.id < value.id)),
          ));
    const ledger = order ? this.store.getLedger(order.id) : null;
    const unallocated =
      activeRefunds.some(
        (refund) =>
          refund.allocations.reduce((sum, line) => sum + line.cents, 0) !==
          refund.amountCents,
      ) ||
      (!!ledger && ledger.match === false);
    const evidenceVerified =
      order &&
      value.proposal.match_evidence.some(
        (span) =>
          value.message.toLowerCase().includes(span.toLowerCase()) &&
          (span.toLowerCase().includes(order.id.toLowerCase()) ||
            order.id.toLowerCase().includes(span.toLowerCase()) ||
            order.customerName.toLowerCase().includes(span.toLowerCase()) ||
            order.email.toLowerCase() === span.toLowerCase()),
      );
    const ambiguous =
      !value.manualOrder &&
      (candidates.length !== 1 ||
        candidates[0].id !== order?.id ||
        !evidenceVerified ||
        value.proposal.confidence < 0.65);
    const check = guard({
      order,
      proposal: value.proposal,
      facts: value.facts,
      now: new Date().toISOString(),
      refundedCents: Math.max(
        activeRefunds.reduce((sum, refund) => sum + refund.amountCents, 0),
        ledger?.remoteRefundedCents || 0,
      ),
      refundedByLine: byLine,
      duplicate,
      ambiguous,
      overrideDuplicate: !!value.duplicateOverride,
      ...(value.approvedCents === null
        ? {}
        : { approvedCents: value.approvedCents }),
      unallocatedRefund: unallocated,
    });
    return { ...value, order, candidates, refunds, check };
  }
  async triageCase(id: string): Promise<DeskCase> {
    const value = this.requireCase(id);
    if (
      ["processing", "refunded", "rejected"].includes(value.status) ||
      this.store.getAttempt(id)
    )
      throw new DeskError("This case can no longer be triaged.");
    const proposal = await triage(this.store, value);
    const current = this.requireCase(id);
    if (
      JSON.stringify(current) !== JSON.stringify(value) ||
      this.store.getAttempt(id)
    )
      throw new DeskError("Case changed while triaging; refresh it.");
    if (!proposal) {
      value.status = "needs_human";
      value.error =
        "AI output was invalid after one retry, or the provider is not configured.";
      this.store.saveCase(value);
      return this.detail(id);
    }
    value.proposal = proposal;
    if (!value.manualOrder)
      value.orderId =
        proposal.matched_order_id &&
        this.store.getOrder(proposal.matched_order_id)
          ? proposal.matched_order_id
          : null;
    if (!value.fixture) {
      const order = value.orderId ? this.store.getOrder(value.orderId) : null;
      value.facts = {
        damagedLineIds: /broken|crack|damage|shatter|rota|grieta/i.test(
          value.message,
        )
          ? proposal.proposed_lines
              .filter((line) =>
                order?.lines.some((item) => item.id === line.item),
              )
              .map((line) => line.item)
          : [],
        hasDamageEvidence:
          /cracked?\s+(handle|base)|shatter|sharp pieces|asa rota|grieta|big crack|broken.*handle/i.test(
            value.message,
          ),
      };
    }
    value.approvedCents = null;
    value.replyDraft = proposal.customer_reply_draft;
    value.error = null;
    this.store.saveCase(value);
    value.status =
      this.detail(id).check?.kind === "blocked" ? "needs_human" : "ready";
    this.store.saveCase(value);
    return this.detail(id);
  }
  createMessage(
    input: Pick<DeskCase, "sender" | "email" | "subject" | "message">,
  ): DeskCase {
    const value: DeskCase = {
      ...input,
      id: `case-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      status: "new",
      orderId: null,
      proposal: null,
      facts: { damagedLineIds: [], hasDamageEvidence: false },
      approvedCents: null,
      replyDraft: "",
      replySent: false,
      fixture: null,
      manualOrder: false,
      duplicateOverride: null,
      error: null,
    };
    this.store.saveCase(value);
    return value;
  }
  edit(
    id: string,
    changes: {
      orderId?: string;
      approvedCents?: number;
      clauseIds?: string[];
      damagedLineIds?: string[];
      hasDamageEvidence?: boolean;
      returnReceivedLineIds?: string[];
      duplicateOverride?: string | null;
      replyDraft?: string;
      replySent?: boolean;
    },
  ): DeskCase {
    const value = this.requireCase(id);
    const moneyChange = Object.keys(changes).some(
      (key) => !["replyDraft", "replySent"].includes(key),
    );
    if (
      moneyChange &&
      (["processing", "refunded", "rejected"].includes(value.status) ||
        this.store.getAttempt(id))
    )
      throw new DeskError(
        "The refund is locked; its order and amount cannot change.",
      );
    if (changes.orderId) {
      if (!this.store.getOrder(changes.orderId))
        throw new DeskError("Unknown order", 400);
      value.orderId = changes.orderId;
      value.manualOrder = true;
      value.approvedCents = null;
      if (value.proposal)
        value.proposal = {
          ...value.proposal,
          matched_order_id: changes.orderId,
          needs_human_reason: null,
        };
    }
    if (changes.clauseIds) {
      if (!value.proposal)
        throw new DeskError("Triage the case before choosing clauses", 400);
      value.proposal.policy_clause_ids = changes.clauseIds;
      value.approvedCents = null;
    }
    if (changes.damagedLineIds)
      value.facts.damagedLineIds = changes.damagedLineIds;
    if (changes.hasDamageEvidence !== undefined)
      value.facts.hasDamageEvidence = changes.hasDamageEvidence;
    if (changes.duplicateOverride !== undefined)
      value.duplicateOverride = changes.duplicateOverride?.trim() || null;
    if (changes.replyDraft !== undefined) value.replyDraft = changes.replyDraft;
    if (changes.replySent !== undefined) value.replySent = changes.replySent;
    this.store.transaction(() => {
      if (changes.returnReceivedLineIds) {
        const order = value.orderId && this.store.getOrder(value.orderId);
        if (!order)
          throw new DeskError(
            "Pick an order before marking a return received",
            400,
          );
        for (const line of order.lines)
          line.returnReceived = changes.returnReceivedLineIds.includes(line.id);
        this.store.saveOrder(order);
      }
      if (changes.approvedCents !== undefined) {
        value.approvedCents = changes.approvedCents;
        this.store.saveCase(value);
        const check = this.detail(id).check;
        if (
          !check ||
          changes.approvedCents > check.computedCents ||
          changes.approvedCents > check.remainderCents ||
          changes.approvedCents <= 0
        )
          throw new DeskError(
            "Amount exceeds the policy allowance or refundable remainder.",
            422,
          );
      }
      this.store.saveCase(value);
      if (moneyChange && value.proposal) {
        value.status =
          this.detail(id).check?.kind === "blocked" ? "needs_human" : "ready";
        this.store.saveCase(value);
      }
    });
    return this.detail(id);
  }
  reject(id: string): DeskCase {
    const value = this.requireCase(id);
    if (
      ["processing", "refunded"].includes(value.status) ||
      this.store.getAttempt(id)
    )
      throw new DeskError("A submitted refund cannot be rejected.");
    value.status = "rejected";
    this.store.saveCase(value);
    return this.detail(id);
  }
  async approve(id: string) {
    let value = this.requireCase(id);
    if (["refunded", "rejected", "processing"].includes(value.status))
      throw new DeskError(
        "This case is already refunded, rejected, or processing. Second approval blocked.",
      );
    let attempt = this.store.getAttempt(id);
    if (attempt?.state === "done")
      throw new DeskError("Second approval blocked.");
    if (!attempt) {
      if (!value.orderId) throw new DeskError("Pick an order before approval.");
      const checkedOrderId = value.orderId;
      await reconcile(this.store, this.paypal, checkedOrderId);
      attempt = this.store.transaction(() => {
        value = this.requireCase(id);
        if (value.orderId !== checkedOrderId)
          throw new DeskError(
            "Order changed during reconciliation. Review and approve again.",
          );
        if (
          ["refunded", "rejected", "processing"].includes(value.status) ||
          this.store.getAttempt(id)
        )
          throw new DeskError("Another approval already claimed this case.");
        const detail = this.detail(id);
        if (!detail.check || detail.check.kind === "blocked" || !detail.order)
          throw new DeskError(
            detail.check?.reasons.join(" ") || "Triage before approval.",
          );
        if (
          this.store
            .listAttempts()
            .some(
              (other) =>
                other.orderId === detail.order!.id &&
                other.caseId !== id &&
                other.state !== "done",
            )
        )
          throw new DeskError(
            "Another refund for this order is processing or unresolved.",
          );
        const result: Attempt = {
          caseId: id,
          orderId: detail.order.id,
          requestId: requestId(`${id}:${detail.order.captureId}`),
          amountCents: detail.check.approvedCents,
          currency: detail.order.currency,
          allocations: distribute(
            detail.check.lines,
            detail.check.approvedCents,
          ),
          state: "processing",
          createdAt: new Date().toISOString(),
        };
        value.status = "processing";
        value.error = null;
        value.approvedCents = result.amountCents;
        value.approvalCheck = detail.check;
        this.store.saveCase(value);
        this.store.saveAttempt(result);
        return result;
      });
    } else {
      if (Date.now() - Date.parse(attempt.createdAt) > 60 * 60 * 1000)
        throw new DeskError(
          "This unresolved request is over an hour old. Review it in PayPal before retrying; its remote idempotency retention cannot be assumed.",
        );
      // Uncertain outcomes retry the exact persisted request, including after a process restart.
      this.store.transaction(() => {
        value = this.requireCase(id);
        if (value.status === "processing")
          throw new DeskError("This refund is already processing.");
        value.status = "processing";
        this.store.saveCase(value);
        attempt!.state = "processing";
        this.store.saveAttempt(attempt!);
      });
    }
    const order = this.store.getOrder(attempt.orderId)!;
    let receipt;
    try {
      receipt = await this.paypal.refund(
        order.captureId,
        attempt.amountCents,
        attempt.currency,
        attempt.requestId,
      );
      if (
        receipt.amount.currency_code !== attempt.currency ||
        decimalToCents(receipt.amount.value) !== attempt.amountCents ||
        !["COMPLETED", "PENDING"].includes(receipt.status)
      )
        throw new DeskError(
          "PayPal refund is not confirmed with the requested amount; keep the request locked.",
        );
      this.store.transaction(() => {
        this.store.saveRefund({
          id: receipt!.id,
          caseId: id,
          orderId: order.id,
          amountCents: attempt!.amountCents,
          currency: attempt!.currency,
          status: receipt!.status,
          requestId: attempt!.requestId,
          allocations: attempt!.allocations,
          createdAt: attempt!.createdAt,
        });
        attempt!.state = "done";
        this.store.saveAttempt(attempt!);
        value = this.requireCase(id);
        value.status = "refunded";
        value.error = null;
        this.store.saveCase(value);
      });
    } catch (error) {
      attempt.state = "uncertain";
      this.store.saveAttempt(attempt);
      value = this.requireCase(id);
      value.status = "failed";
      value.error = error instanceof Error ? error.message : "Refund failed";
      this.store.saveCase(value);
      throw error;
    }
    try {
      return {
        case: this.detail(id),
        refund: receipt,
        ledger: await reconcile(this.store, this.paypal, order.id),
      };
    } catch (error) {
      return {
        case: this.detail(id),
        refund: receipt,
        ledger: ledgerRow(this.store, order.id),
        reconciliationError:
          error instanceof Error ? error.message : "Reconciliation failed",
      };
    }
  }
  recoverInterrupted() {
    for (const attempt of this.store
      .listAttempts()
      .filter((value) => value.state === "processing")) {
      attempt.state = "uncertain";
      this.store.saveAttempt(attempt);
      const value = this.requireCase(attempt.caseId);
      value.status = "failed";
      value.error =
        "Interrupted approval. Retry the same locked request to recover its outcome.";
      this.store.saveCase(value);
    }
  }
}

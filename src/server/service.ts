import { randomUUID } from "node:crypto";
import { guard, distribute } from "../core/guardrails.js";
import {
  emptyFacts,
  factsSchema,
  type DeskCase,
  type Facts,
  type GuardContext,
  type Proposal,
} from "../core/types.js";
import {
  candidatesFor,
  identityConflict,
  proposedFactsFor,
  triage,
  fallback,
  type TriageSettings,
} from "./triage.js";
import {
  ledgerRow,
  reconcile,
  readCaptureRefunds,
  importAttemptReceipt,
} from "./reconcile.js";
import { requestId, type PayPalClient, type PayPalRefund } from "./paypal.js";
import type { Attempt, Store } from "./db.js";
import { redactError } from "./errors.js";

export const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;
export class DeskError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "DeskError";
    this.status = status;
  }
}
export class DeskService {
  private activeAttempts = new Set<string>();
  private triageActive = 0;
  readonly store: Store;
  readonly paypal: PayPalClient;
  private triageSettings: TriageSettings;
  private now: () => string;
  constructor(store: Store, paypal: PayPalClient, triageSettings: TriageSettings = {}, now = () => new Date().toISOString()) {
    this.store = store;
    this.paypal = paypal;
    this.triageSettings = triageSettings;
    this.now = now;
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
    const attempt = this.store.getAttempt(id);
    const attemptAge = attempt ? Date.now() - Date.parse(attempt.createdAt) : NaN;
    const ambiguous =
      !value.manualOrder &&
      (identityConflict(this.store, value, order) ||
        (value.proposal !== null && value.proposal.confidence < 0.65));
    const base = {
      ...value,
      order,
      candidates,
      refunds,
      ambiguous,
      attempt: attempt
        ? {
            id: attempt.id,
            state: attempt.state,
            createdAt: attempt.createdAt,
            amountCents: attempt.amountCents,
            currency: attempt.snapshot?.order.currency,
            retryOriginalAllowed:
              attempt.state === "uncertain" &&
              !attempt.refundId &&
              attemptAge >= 0 && attemptAge <= IDEMPOTENCY_WINDOW_MS,
            retryAllowed:
              attempt.state === "uncertain" &&
              !!attempt.remoteAbsent &&
              attemptAge > IDEMPOTENCY_WINDOW_MS,
          }
        : null,
    };
    if (!value.proposal) return base;
    if ((attempt || value.status === "refunded") && value.approvalCheck)
      return { ...base, check: value.approvalCheck };
    const activeRefunds = refunds.filter((refund) =>
      ["COMPLETED", "PENDING"].includes(refund.status),
    );
    const byLine: Record<string, number> = {};
    const quantities: Record<string, number> = {};
    for (const refund of activeRefunds) {
      for (const allocation of refund.allocations)
        byLine[allocation.item] =
          (byLine[allocation.item] || 0) + allocation.cents;
      for (const item of refund.returnedItems || [])
        quantities[item.item] = (quantities[item.item] || 0) + item.quantity;
    }
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
      ) || ledger?.match === false;
    const context: GuardContext = {
      order,
      proposal: value.proposal,
      facts: value.confirmedFacts,
      now: this.now(),
      refundedCents: Math.max(
        activeRefunds.reduce((sum, refund) => sum + refund.amountCents, 0),
        (ledger?.remoteRefundedCents || 0) + (ledger?.pendingCents || 0),
      ),
      refundedByLine: byLine,
      refundedQuantities: quantities,
      duplicate,
      ambiguous,
      overrideDuplicate: !!value.duplicateOverride,
      ...(value.approvedCents === null
        ? {}
        : { approvedCents: value.approvedCents }),
      unallocatedRefund: unallocated,
    };
    const check = guard(context);
    const proposedCheck = guard({ ...context, facts: value.proposedFacts, approvedCents: undefined });
    return { ...base, check, proposedCheck };
  }
  async triageCase(id: string): Promise<DeskCase> {
    if (this.triageActive >= 2)
      throw new DeskError(
        "Two triage jobs are already running. Try again shortly.",
        429,
      );
    const value = this.requireCase(id);
    if (
      ["processing", "pending", "refunded", "rejected"].includes(
        value.status,
      ) ||
      this.store.getAttempt(id)
    )
      throw new DeskError("This case can no longer be triaged.");
    this.triageActive++;
    try {
      const { proposal, unavailable, trace } = await triage(this.store, value, this.triageSettings);
      const current = this.requireCase(id);
      if (current.revision !== value.revision || this.store.getAttempt(id))
        throw new DeskError("This case changed; review again");
      value.proposal = proposal;
      value.triageTrace = trace;
      if (!value.manualOrder)
        value.orderId =
          proposal.matched_order_id &&
          candidatesFor(this.store, value).some(
            (order) => order.id === proposal.matched_order_id,
          )
            ? proposal.matched_order_id
            : null;
      value.proposedFacts = proposedFactsFor(
        value,
        proposal,
        value.orderId ? this.store.getOrder(value.orderId) : null,
      );
      value.confirmedFacts = emptyFacts();
      value.approvedCents = null;
      value.replyDraft = proposal.customer_reply_draft;
      value.error = unavailable
        ? "AI unavailable — keyword triage used. Review the proposed facts."
        : null;
      this.store.saveCase(value);
      if (value.triageTrace) value.triageTrace.calculatorAllowanceCents = this.detail(id).proposedCheck?.computedCents ?? 0;
      value.status =
        this.detail(id).check?.kind === "blocked" ? "needs_human" : "ready";
      this.store.saveCase(value);
      return this.detail(id);
    } finally {
      this.triageActive--;
    }
  }
  createMessage(
    input: Pick<DeskCase, "sender" | "email" | "subject" | "message">,
  ): DeskCase {
    const value: DeskCase = {
      ...input,
      id: `case-${randomUUID()}`,
      revision: 1,
      createdAt: new Date().toISOString(),
      status: "new",
      orderId: null,
      proposal: null,
      proposedFacts: emptyFacts(),
      confirmedFacts: emptyFacts(),
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
      intent?: Proposal["intent"];
      confirmedFacts?: Facts;
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
      (["processing", "pending", "refunded", "rejected"].includes(
        value.status,
      ) ||
        this.store.getAttempt(id))
    )
      throw new DeskError(
        "The refund is locked; its order and amount cannot change.",
      );
    if (!value.proposal && (changes.orderId || changes.clauseIds || changes.intent)) {
      value.proposal = fallback(value, candidatesFor(this.store, value));
      value.triageTrace = { provider: "owner", model: "manual-review", source: "manual", attempts: 0, latencyMs: 0, toolCalls: [], evidenceSpans: [], proposal: structuredClone(value.proposal) };
    }
    if (changes.orderId) {
      const order = this.store.getOrder(changes.orderId);
      if (!order) throw new DeskError("Unknown order", 400);
      if (value.orderId !== order.id && !candidatesFor(this.store, value).some((candidate) => candidate.id === order.id))
        throw new DeskError("Order must be among this sender's candidate orders", 422);
      if (value.orderId !== changes.orderId)
        value.confirmedFacts = emptyFacts();
      value.orderId = changes.orderId;
      value.manualOrder = true;
      value.approvedCents = null;
      if (value.proposal) {
        value.proposal = {
          ...value.proposal,
          matched_order_id: changes.orderId,
          needs_human_reason: null,
        };
        value.proposedFacts = proposedFactsFor(value, value.proposal, order);
      }
    }
    if (changes.clauseIds) {
      if (!value.proposal)
        throw new DeskError("Triage the case before choosing clauses", 400);
      value.proposal.policy_clause_ids = changes.clauseIds;
      value.approvedCents = null;
    }
    if (changes.intent && value.proposal) {
      value.proposal.intent = changes.intent;
      value.approvedCents = null;
    }
    if (changes.confirmedFacts) {
      const facts = factsSchema.parse(changes.confirmedFacts);
      const order = value.orderId ? this.store.getOrder(value.orderId) : null;
      if (!order)
        throw new DeskError("Pick an order before confirming facts", 400);
      for (const items of [facts.damagedItems, facts.returnedItems]) {
        if (
          new Set(items.map((item) => item.item)).size !== items.length ||
          items.some(
            (item) =>
              !order.lines.some(
                (line) =>
                  line.id === item.item && item.quantity <= line.quantity,
              ),
          )
        )
          throw new DeskError(
            "Confirmed items and quantities must belong to the selected order",
            422,
          );
      }
      if (
        facts.deliveryDates &&
        (!Number.isFinite(Date.parse(facts.deliveryDates.promisedAt)) ||
          !Number.isFinite(Date.parse(facts.deliveryDates.deliveredAt)))
      )
        throw new DeskError("Invalid confirmed dates", 422);
      value.confirmedFacts = facts;
      value.approvedCents = null;
    }
    if (changes.duplicateOverride !== undefined) {
      const reason = changes.duplicateOverride?.trim() || null;
      if (reason && reason.length < 8)
        throw new DeskError("Give a reason for the duplicate override", 400);
      value.duplicateOverride = reason;
    }
    if (changes.replyDraft !== undefined) value.replyDraft = changes.replyDraft;
    if (changes.replySent !== undefined) value.replySent = changes.replySent;
    this.store.transaction(() => {
      if (changes.approvedCents !== undefined)
        value.approvedCents = changes.approvedCents;
      this.store.saveCase(value);
      const check = this.detail(id).check;
      if (
        changes.approvedCents !== undefined &&
        (!check ||
          changes.approvedCents > check.computedCents ||
          changes.approvedCents > check.remainderCents ||
          !Number.isSafeInteger(changes.approvedCents) ||
          changes.approvedCents <= 0)
      )
        throw new DeskError(
          "Amount exceeds the policy allowance or refundable remainder.",
          422,
        );
      if (moneyChange && value.proposal) {
        value.status = check?.kind === "blocked" ? "needs_human" : "ready";
        this.store.saveCase(value);
      }
    });
    return this.detail(id);
  }
  reject(id: string): DeskCase {
    const value = this.requireCase(id);
    if (
      ["processing", "pending", "refunded"].includes(value.status) ||
      this.store.getAttempt(id)
    )
      throw new DeskError("A submitted refund cannot be rejected.");
    value.status = "rejected";
    this.store.saveCase(value);
    return this.detail(id);
  }
  async approve(
    id: string,
    reviewed: { revision: number; approvedCents: number },
  ) {
    let value = this.requireCase(id);
    const assertReviewed = () => {
      if (
        value.revision !== reviewed.revision ||
        this.detail(id).check?.approvedCents !== reviewed.approvedCents
      )
        throw new DeskError("This case changed; review again");
    };
    assertReviewed();
    if (
      ["refunded", "rejected", "processing", "pending"].includes(value.status)
    )
      throw new DeskError(
        "This case is already refunded, rejected, or processing. Second approval blocked.",
      );
    let attempt = this.store.getAttempt(id);
    if (attempt && attempt.state !== "uncertain")
      throw new DeskError("Second approval blocked.");
    if (!attempt) {
      if (!value.orderId) throw new DeskError("Pick an order before approval.");
      const checkedOrderId = value.orderId;
      await reconcile(this.store, this.paypal, checkedOrderId);
      attempt = this.store.transaction(() => {
        value = this.requireCase(id);
        assertReviewed();
        if (this.store.getAttempt(id))
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
                !["completed", "failed"].includes(other.state),
            )
        )
          throw new DeskError(
            "Another refund for this order is processing or unresolved.",
          );
        const allocations = distribute(
          detail.check.lines,
          reviewed.approvedCents,
        );
        const attemptId = requestId(`${id}:${detail.order.captureId}`);
        const result: Attempt = {
          id: attemptId,
          caseId: id,
          orderId: detail.order.id,
          requestId: attemptId,
          amountCents: reviewed.approvedCents,
          currency: detail.order.currency,
          allocations,
          state: "submitted",
          createdAt: new Date().toISOString(),
          revision: reviewed.revision,
          snapshot: structuredClone({
            revision: reviewed.revision,
            amountCents: reviewed.approvedCents,
            allocations,
            clauseIds: value.proposal!.policy_clause_ids,
            facts: value.confirmedFacts,
            order: detail.order,
            duplicateOverride: value.duplicateOverride,
          }),
          returnFeeCaseId: value.proposal!.policy_clause_ids.includes("P3.1")
            ? id
            : null,
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
      if (Date.now() - Date.parse(attempt.createdAt) > IDEMPOTENCY_WINDOW_MS)
        throw new DeskError(
          "This unresolved request is over an hour old. Check PayPal before retrying.",
        );
      this.store.transaction(() => {
        value = this.requireCase(id);
        assertReviewed();
        if (this.activeAttempts.has(id))
          throw new DeskError("This refund is already processing.");
        value.status = "processing";
        this.store.saveCase(value);
        attempt!.state = "submitted";
        this.store.saveAttempt(attempt!);
      });
    }
    return this.sendAttempt(attempt);
  }
  private async sendAttempt(attempt: Attempt) {
    const id = attempt.caseId;
    if (this.activeAttempts.has(id))
      throw new DeskError("This refund is already processing.");
    this.activeAttempts.add(id);
    let receipt: PayPalRefund;
    try {
      receipt = await this.paypal.refund(
        attempt.snapshot.order.captureId,
        attempt.amountCents,
        attempt.currency,
        attempt.requestId,
        attempt.id,
      );
      this.store.transaction(() =>
        importAttemptReceipt(this.store, attempt, receipt),
      );
    } catch (error) {
      this.store.transaction(() => {
        attempt.state = "uncertain";
        attempt.remoteAbsent = false;
        this.store.saveAttempt(attempt);
        const value = this.requireCase(id);
        value.status = "needs_human";
        value.error = `${redactError(error)}. Outcome uncertain; Check PayPal before retrying.`;
        this.store.saveCase(value);
      });
      throw error;
    } finally {
      this.activeAttempts.delete(id);
    }
    try {
      const ledger = await reconcile(this.store, this.paypal, attempt.orderId);
      return { case: this.detail(id), refund: receipt, ledger };
    } catch (error) {
      return {
        case: this.detail(id),
        refund: receipt,
        ledger: ledgerRow(this.store, attempt.orderId),
        reconciliationError: redactError(error),
      };
    }
  }
  async checkPayPal(id: string) {
    const attempt = this.store.getAttempt(id);
    if (!attempt) throw new DeskError("No refund attempt to recover.");
    if (this.activeAttempts.has(id))
      throw new DeskError(
        "The refund request is still running; check after it finishes.",
      );
    const { receipts } = await readCaptureRefunds(
      this.paypal,
      attempt.snapshot.order,
    );
    const found = receipts.filter(
      (receipt) =>
        receipt.invoice_id === attempt.id ||
        receipt.custom_id === attempt.id ||
        receipt.id === attempt.refundId,
    );
    if (found.length > 1)
      throw new DeskError(
        "Multiple PayPal refunds match this attempt. Manual investigation required.",
      );
    this.store.transaction(() => {
      const current = this.store.getAttempt(id)!;
      if (
        current.requestId !== attempt.requestId ||
        this.activeAttempts.has(id)
      )
        throw new DeskError("Attempt changed while checking PayPal.");
      if (found[0]) importAttemptReceipt(this.store, current, found[0]);
      else if (!["completed", "pending", "failed"].includes(current.state)) {
        current.state = "uncertain";
        current.remoteAbsent = true;
      }
      current.checkedAt = new Date().toISOString();
      this.store.saveAttempt(current);
    });
    const ledger = await reconcile(this.store, this.paypal, attempt.orderId);
    return {
      case: this.detail(id),
      ledger,
      recovered: !!found[0],
      retryAllowed: this.detail(id).attempt?.retryAllowed || false,
    };
  }
  async retryWithNewId(
    id: string,
    input: { confirmed: boolean; reason: string; revision: number },
  ) {
    if (!input.confirmed || input.reason.trim().length < 8)
      throw new DeskError(
        "Confirm the duplicate-refund warning and give a reason.",
        400,
      );
    if (this.requireCase(id).revision !== input.revision)
      throw new DeskError("This case changed; review again");
    const checked = await this.checkPayPal(id);
    if (
      checked.recovered ||
      !checked.retryAllowed ||
      checked.ledger.match !== true
    )
      throw new DeskError(
        "Retry unavailable: PayPal must show no matching receipt and a matching ledger after the request-id window.",
      );
    const attempt = this.store.transaction(() => {
      const current = this.store.getAttempt(id)!;
      if (
        this.activeAttempts.has(id) ||
        current.state !== "uncertain" ||
        !current.remoteAbsent ||
        Date.now() - Date.parse(current.createdAt) <= IDEMPOTENCY_WINDOW_MS
      )
        throw new DeskError("Another action claimed this attempt.");
      current.retryHistory = [
        ...(current.retryHistory || []),
        {
          requestId: current.requestId,
          createdAt: current.createdAt,
          reason: input.reason.trim(),
        },
      ];
      current.requestId = requestId(`${current.id}:${randomUUID()}`);
      current.createdAt = new Date().toISOString();
      current.state = "submitted";
      current.remoteAbsent = false;
      const value = this.requireCase(id);
      value.status = "processing";
      this.store.saveCase(value);
      this.store.saveAttempt(current);
      return current;
    });
    return this.sendAttempt(attempt);
  }
  recoverInterrupted() {
    for (const attempt of this.store
      .listAttempts()
      .filter(
        (value) =>
          value.state === "submitted" ||
          (value.state as string) === "processing",
      )) {
      attempt.state = "uncertain";
      this.store.saveAttempt(attempt);
      const value = this.requireCase(attempt.caseId);
      value.status = "needs_human";
      value.error =
        "Interrupted approval. Check PayPal to recover the frozen attempt.";
      this.store.saveCase(value);
    }
  }
}

import { z } from "zod";

export interface OrderLine {
  id: string;
  productId: string;
  title: string;
  quantity: number;
  unitCents: number;
  sale: boolean;
  returnReceived: boolean;
}
export interface Order {
  id: string;
  customerId: string;
  customerName: string;
  email: string;
  paypalOrderId: string;
  captureId: string;
  currency: string;
  capturedCents: number;
  shippingCents: number;
  orderedAt: string;
  promisedAt: string;
  deliveredAt: string;
  lines: OrderLine[];
}
// A model can return "2026-99-01": the shape matches but no such day exists.
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }, "Not a calendar date");
export const factsSchema = z
  .object({
    damagedItems: z
      .array(
        z
          .object({ item: z.string(), quantity: z.number().int().positive() })
          .strict(),
      )
      .max(30),
    hasDamageEvidence: z.boolean(),
    returnedItems: z
      .array(
        z
          .object({ item: z.string(), quantity: z.number().int().positive() })
          .strict(),
      )
      .max(30),
    returnReceived: z.boolean(),
    deliveryDates: z
      .object({
        promisedAt: calendarDate,
        deliveredAt: calendarDate,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Facts = z.infer<typeof factsSchema>;
export const emptyFacts = (): Facts => ({
  damagedItems: [],
  hasDamageEvidence: false,
  returnedItems: [],
  returnReceived: false,
  deliveryDates: null,
});
export const proposalSchema = z
  .object({
    matched_order_id: z.string().nullable(),
    match_evidence: z.array(z.string().min(1)).max(12),
    intent: z.enum(["refund", "exchange", "question", "other"]),
    policy_clause_ids: z.array(z.string()).max(8),
    proposed_lines: z
      .array(
        z
          .object({
            item: z.string(),
            reason: z.string(),
            amount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(30),
    proposed_total: z.number().int().nonnegative().max(1_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    customer_reply_draft: z.string().max(8000),
    confidence: z.number().min(0).max(1),
    needs_human_reason: z.string().nullable(),
    proposed_facts: factsSchema.optional(),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;
export interface Allocation {
  item: string;
  cents: number;
}
export interface GuardContext {
  order: Order | null;
  proposal: Proposal;
  facts: Facts;
  now: string;
  refundedCents: number;
  refundedByLine: Record<string, number>;
  duplicate: boolean;
  ambiguous: boolean;
  overrideDuplicate?: boolean;
  approvedCents?: number;
  unallocatedRefund?: boolean;
  refundedQuantities?: Record<string, number>;
}
export interface Check {
  kind: "pass" | "adjusted" | "blocked";
  computedCents: number;
  approvedCents: number;
  modelCents: number;
  remainderCents: number;
  reasons: string[];
  lines: Allocation[];
}
export type CaseStatus =
  | "new"
  | "ready"
  | "needs_human"
  | "processing"
  | "pending"
  | "refunded"
  | "rejected"
  | "failed";
export interface TriageTrace {
  provider: string;
  model: string;
  source: "live" | "fixture" | "offline" | "unavailable" | "manual";
  latencyMs: number;
  attempts: number;
  toolCalls: { name: string; arguments: Record<string, unknown>; summary: string; attempt: number }[];
  evidenceSpans: string[];
  proposal: Proposal;
  calculatorAllowanceCents?: number;
}
export interface DeskCase {
  id: string;
  revision: number;
  sender: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
  status: CaseStatus;
  orderId: string | null;
  proposal: Proposal | null;
  proposedFacts: Facts;
  confirmedFacts: Facts;
  approvedCents: number | null;
  replyDraft: string;
  replySent: boolean;
  fixture: string | null;
  manualOrder: boolean;
  duplicateOverride: string | null;
  error: string | null;
  triageTrace?: TriageTrace;
  proposedCheck?: Check;
  approvalCheck?: Check;
  check?: Check;
  order?: Order | null;
  candidates?: Order[];
  refunds?: Refund[];
  ambiguous?: boolean;
  attempt?: {
    id: string;
    state: string;
    createdAt: string;
    amountCents: number;
    currency?: string;
    retryOriginalAllowed?: boolean;
    retryAllowed: boolean;
  } | null;
}
export interface Refund {
  id: string;
  caseId: string | null;
  orderId: string;
  amountCents: number;
  currency: string;
  status: string;
  requestId: string;
  allocations: Allocation[];
  createdAt: string;
  returnFeeCaseId?: string | null;
  returnedItems?: Facts["returnedItems"];
}
export interface LedgerRow {
  orderId: string;
  customer: string;
  captureId: string;
  currency: string;
  capturedCents: number;
  refundedCents: number;
  netCents: number;
  paypalStatus: string;
  remoteCapturedCents: number | null;
  remoteRefundedCents: number | null;
  match: boolean | null;
  checkedAt: string | null;
  error: string | null;
  refundIds: string[];
  pendingCents: number;
  unexpectedRefundIds: string[];
}

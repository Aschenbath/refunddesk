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
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;
export interface Facts {
  damagedLineIds: string[];
  hasDamageEvidence: boolean;
}
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
  | "refunded"
  | "rejected"
  | "failed";
export interface DeskCase {
  id: string;
  sender: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
  status: CaseStatus;
  orderId: string | null;
  proposal: Proposal | null;
  facts: Facts;
  approvedCents: number | null;
  replyDraft: string;
  replySent: boolean;
  fixture: string | null;
  manualOrder: boolean;
  duplicateOverride: string | null;
  error: string | null;
  approvalCheck?: Check;
  check?: Check;
  order?: Order | null;
  candidates?: Order[];
  refunds?: Refund[];
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
}

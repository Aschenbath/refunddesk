import type { DeskCase } from "../core/types.js";
import { memberships } from "./grid-state.js";

export type BatchAction = "triage" | "reconcile";
export interface BatchReport { summary: string; details: string[] }
export const csvCell = (value: unknown) => typeof value === "string" && /^[=+@\-\t\r]/.test(value) ? `'${value}` : value == null ? "" : String(value);
export function selectionSummary(cases: DeskCase[]) {
  return cases.reduce((sum, value) => {
    sum.count++;
    sum.modelCents += value.proposal?.proposed_total ?? 0;
    sum.allowedCents += value.check?.computedCents ?? 0;
    if (value.status === "refunded") sum.refunded++;
    else if (value.status !== "rejected" && value.check?.kind === "blocked") sum.blocked++;
    if (memberships(value).includes("Ready to approve")) sum.ready++;
    return sum;
  }, { count: 0, modelCents: 0, allowedCents: 0, blocked: 0, ready: 0, refunded: 0 });
}
export function outcomeRows(cases: DeskCase[]) {
  return cases.map((value) => {
    // The API includes every receipt for the order; only this case's receipts are its outcome.
    const refunds = value.refunds?.filter((refund) => refund.caseId === value.id) ?? [];
    return {
      caseId: value.id, revision: value.revision, customer: value.sender, orderId: value.orderId ?? "", status: value.status,
      approvedCents: value.attempt?.amountCents ?? value.check?.approvedCents ?? value.approvedCents,
      refundedCents: refunds.filter((refund) => refund.status === "COMPLETED").reduce((sum, refund) => sum + refund.amountCents, 0),
      currency: value.order?.currency ?? value.proposal?.currency ?? "",
      refundIds: refunds.map((refund) => refund.id).join(" | "),
      blockingReasons: [...new Set([...(value.check?.kind === "blocked" ? value.check.reasons : []), ...(value.error ? [value.error] : [])])].join(" | "),
    };
  });
}
export function outcomesCsv(cases: DeskCase[]) {
  const dollars = (cents: number | null) => cents === null ? "" : (cents / 100).toFixed(2);
  const rows = outcomeRows(cases).map((row) => [row.caseId, row.revision, row.customer, row.orderId, row.status,
    dollars(row.approvedCents), dollars(row.refundedCents), row.currency, row.refundIds, row.blockingReasons]);
  return [["Case", "Revision", "Customer", "Order", "Status", "Approved ($)", "Refunded ($)", "Currency", "Refund IDs", "Blocking reasons"], ...rows]
    .map((row) => row.map((cell) => `"${csvCell(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

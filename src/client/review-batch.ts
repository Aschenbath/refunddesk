import type { DeskCase } from "../core/types.js";
import { memberships } from "./grid-state.js";
import { ApiError } from "./api.js";
import { caseApprovedCurrency, caseMoneyTotals, caseRefunds, formatMoneyTotals, singleCurrencyCents, sumMoney } from "./money-state.js";

export type BatchAction = "triage" | "reconcile";
export interface BatchReport { summary: string; details: string[] }
const TRIAGE_MAX_RETRIES = 2;
const TRIAGE_MAX_WAIT_MS = 60_000;
export async function triageBatchCase(id: string, options: {
  readCase: (id: string) => Promise<Pick<DeskCase, "status">>;
  triageCase: (id: string) => Promise<unknown>;
  onWait: (milliseconds: number, retry: number) => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<DeskCase["status"] | null> {
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let retry = 0; ; retry++) {
    // Waiting can give another session time to review or submit this case.
    const value = await options.readCase(id);
    if (value.status !== "new") return value.status;
    try {
      await options.triageCase(id);
      return null;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || retry >= TRIAGE_MAX_RETRIES) throw error;
      const milliseconds = error.retryAfterMs ?? TRIAGE_MAX_WAIT_MS;
      // Never retry earlier than a server's longer requested delay.
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > TRIAGE_MAX_WAIT_MS) throw error;
      options.onWait(milliseconds, retry + 1);
      await wait(milliseconds);
    }
  }
}
export const csvCell = (value: unknown) => typeof value === "string" && /^[=+@\-\t\r]/.test(value) ? `'${value}` : value == null ? "" : String(value);
export function selectionSummary(cases: DeskCase[]) {
  const amounts = cases.map(caseMoneyTotals);
  const modelTotals = sumMoney(amounts.flatMap((value) => value.model));
  const allowedTotals = sumMoney(amounts.flatMap((value) => value.allowed));
  const summary = cases.reduce((sum, value) => {
    sum.count++;
    if (value.status === "refunded") sum.refunded++;
    else if (value.status !== "rejected" && value.check?.kind === "blocked") sum.blocked++;
    if (memberships(value).includes("Ready to approve")) sum.ready++;
    return sum;
  }, { count: 0, blocked: 0, ready: 0, refunded: 0 });
  return { ...summary, modelCents: singleCurrencyCents(modelTotals), allowedCents: singleCurrencyCents(allowedTotals), modelTotals, allowedTotals };
}
export function outcomeRows(cases: DeskCase[]) {
  return cases.map((value) => {
    // The API includes every receipt for the order; only this case's receipts are its outcome.
    const refunds = caseRefunds(value), amounts = caseMoneyTotals(value);
    return {
      caseId: value.id, revision: value.revision, customer: value.sender, orderId: value.orderId ?? "", status: value.status,
      approvedCents: value.attempt?.amountCents ?? value.check?.approvedCents ?? value.approvedCents,
      refundedCents: singleCurrencyCents(amounts.refunded),
      currency: caseApprovedCurrency(value) ?? "",
      refundedTotals: amounts.refunded,
      refundIds: refunds.map((refund) => refund.id).join(" | "),
      blockingReasons: [...new Set([...(value.check?.kind === "blocked" ? value.check.reasons : []), ...(value.error ? [value.error] : [])])].join(" | "),
    };
  });
}
export function outcomesCsv(cases: DeskCase[]) {
  const dollars = (cents: number | null) => cents === null ? "" : (cents / 100).toFixed(2);
  const rows = outcomeRows(cases).map((row) => [row.caseId, row.revision, row.customer, row.orderId, row.status,
    row.currency || row.approvedCents === null ? dollars(row.approvedCents) : `${row.approvedCents} minor units`,
    row.refundedTotals.length < 2 && row.refundedTotals.every((value) => value.currency) ? dollars(row.refundedCents) : formatMoneyTotals(row.refundedTotals),
    row.currency || "Unknown", row.refundIds, row.blockingReasons,
    row.refundedTotals.map((value) => value.currency ?? "Unknown").join(" | ")]);
  return [["Case", "Revision", "Customer", "Order", "Status", "Approved", "Refunded", "Approved currency", "Refund IDs", "Blocking reasons", "Refunded currency"], ...rows]
    .map((row) => row.map((cell) => `"${csvCell(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

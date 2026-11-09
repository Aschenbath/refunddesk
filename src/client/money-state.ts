import type { DeskCase } from "../core/types.js";
import { money } from "./api.js";

export interface MoneyValue { cents: number | null | undefined; currency: string | null | undefined }
export interface MoneyTotal { cents: number; currency: string | null }
const currencyCode = (value: string | null | undefined): string | null => value && /^[A-Z]{3}$/.test(value) ? value : null;
const frozenCheck = (value: DeskCase) => !!value.approvalCheck && (!!value.attempt || value.status === "refunded");

export function caseCheckCurrency(value: DeskCase): string | null {
  return currencyCode(frozenCheck(value) ? value.attempt?.currency : value.order?.currency);
}
export function caseApprovedCurrency(value: DeskCase): string | null {
  return currencyCode(value.attempt || value.status === "refunded" ? value.attempt?.currency : value.order?.currency);
}
// This is the unit of check.modelCents. The proposal itself carries its own unit.
export function caseModelCurrency(value: DeskCase): string | null {
  return frozenCheck(value)
    ? value.approvalCheck?.kind === "blocked" ? null : currencyCode(value.attempt?.currency)
    : currencyCode(value.proposal?.currency);
}
export function caseRefunds(value: DeskCase) {
  return value.refunds?.filter((refund) => refund.caseId === value.id && refund.orderId === value.orderId) ?? [];
}

export function sumMoney(values: MoneyValue[]): MoneyTotal[] {
  const known = new Map<string, number>(), unknown: MoneyTotal[] = [];
  for (const value of values) {
    if (value.cents == null) continue;
    const currency = currencyCode(value.currency);
    if (currency) known.set(currency, (known.get(currency) ?? 0) + value.cents);
    // Unknown units cannot safely be combined, even with other unknown units.
    else unknown.push({ cents: value.cents, currency: null });
  }
  return [...[...known.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ cents, currency })), ...unknown];
}
export function singleCurrencyCents(totals: MoneyTotal[]): number | null {
  return totals.length === 0 ? 0 : totals.length === 1 ? totals[0]!.cents : null;
}
export function formatMoneyTotals(totals: MoneyTotal[]): string {
  return totals.length ? totals.map((value) => money(value.cents, value.currency)).join(" + ") : "—";
}
export function caseMoneyTotals(value: DeskCase) {
  const completed = caseRefunds(value).filter((refund) => refund.status === "COMPLETED");
  return {
    model: sumMoney([{ cents: value.proposal?.proposed_total, currency: value.proposal?.currency }]),
    allowed: sumMoney([{ cents: value.check?.computedCents, currency: caseCheckCurrency(value) }]),
    approved: sumMoney([{ cents: value.attempt?.amountCents ?? value.check?.approvedCents ?? value.approvedCents, currency: caseApprovedCurrency(value) }]),
    refunded: completed.length
      ? sumMoney(completed.map((refund) => ({ cents: refund.amountCents, currency: refund.currency })))
      : value.order ? [{ cents: 0, currency: currencyCode(value.order.currency) }] : [],
  };
}

import { policies, clause } from "./policies.js";
import type { Allocation, Facts, Order } from "./types.js";

const day = 86_400_000;
export function businessDaysAfter(promised: string, delivered: string): number {
  const start = Date.parse(`${promised.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${delivered.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new Error("Invalid delivery dates");
  let count = 0;
  for (let time = start + day; time <= end; time += day) {
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}
export function calculate(
  order: Order,
  clauseIds: string[],
  facts: Facts,
  now: string,
): { lines: Allocation[]; reasons: string[] } {
  const reasons: string[] = [];
  const clauses = policies.filter((p) => clauseIds.includes(p.id));
  if (
    !clauses.length ||
    clauseIds.some((id) => !policies.some((p) => p.id === id))
  )
    return { lines: [], reasons: ["Cite a known policy clause."] };
  if (new Set(clauses.map((p) => p.family)).size !== 1)
    return {
      lines: [],
      reasons: ["Different policy families cannot be combined."],
    };
  const has = (id: string) => clauseIds.includes(id);
  const amounts = new Map<string, number>();
  const add = (item: string, cents: number) => amounts.set(item, cents);
  if (clauses[0].family === "damage") {
    if (!has("P1.1")) reasons.push("P1.2 requires P1.1.");
    if (!facts.hasDamageEvidence || !facts.damagedLineIds.length)
      reasons.push(
        "A photo or clear damage description and affected items are required.",
      );
    if (
      facts.damagedLineIds.some(
        (id) => !order.lines.some((line) => line.id === id),
      )
    )
      reasons.push("An affected item is not in this order.");
    if (!reasons.length) {
      for (const line of order.lines)
        if (facts.damagedLineIds.includes(line.id))
          add(line.id, line.unitCents * line.quantity);
      if (has("P1.2")) {
        if (order.lines.every((line) => facts.damagedLineIds.includes(line.id)))
          add("shipping", order.shippingCents);
        else
          reasons.push(
            "Shipping is eligible only when every item arrived damaged.",
          );
      }
    }
  }
  if (clauses[0].family === "late") {
    const late = businessDaysAfter(order.promisedAt, order.deliveredAt);
    if (!has("P2.1")) reasons.push("P2.2 requires P2.1.");
    if (late <= clause("P2.1").businessDays)
      reasons.push(
        `Delivery was ${late} business days late; more than ${clause("P2.1").businessDays} are required.`,
      );
    if (has("P2.2") && late <= clause("P2.2").businessDays)
      reasons.push(
        `The 15% item refund requires more than ${clause("P2.2").businessDays} business days late (found ${late}).`,
      );
    if (!reasons.length) {
      add("shipping", order.shippingCents);
      if (has("P2.2"))
        for (const line of order.lines)
          add(
            line.id,
            Math.round(
              (line.quantity * line.unitCents * clause("P2.2").basisPoints) /
                10000,
            ),
          );
    }
  }
  if (clauses[0].family === "return") {
    const age = Math.floor(
      (Date.parse(`${now.slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${order.deliveredAt.slice(0, 10)}T00:00:00Z`)) /
        day,
    );
    if (!Number.isFinite(age) || age < 0 || age > clause("P3.1").days)
      reasons.push(
        `Return must be within ${clause("P3.1").days} days of delivery.`,
      );
    if (!has("P3.1")) reasons.push("No eligible return clause cited.");
    const returned = order.lines.filter(
      (line) => line.returnReceived && !line.sale,
    );
    if (!returned.length)
      reasons.push(
        "Return has not been received, or all returned items were on sale.",
      );
    if (!reasons.length) {
      let deduction: number = clause("P3.1").deductionCents;
      for (const line of returned) {
        const total = line.quantity * line.unitCents;
        const taken = Math.min(total, deduction);
        deduction -= taken;
        add(line.id, total - taken);
      }
    }
  }
  // An ineligible clause combination fails closed rather than silently dropping a cited rule.
  return {
    lines: reasons.length
      ? []
      : [...amounts].map(([item, cents]) => ({ item, cents })),
    reasons,
  };
}

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
    if (!facts.hasDamageEvidence || !facts.damagedItems.length)
      reasons.push(
        "A photo or clear damage description and affected items are required.",
      );
    if (
      facts.damagedItems.some(
        ({ item, quantity }) =>
          !order.lines.some(
            (line) =>
              line.id === item &&
              Number.isSafeInteger(quantity) &&
              quantity > 0 &&
              quantity <= line.quantity,
          ),
      ) ||
      new Set(facts.damagedItems.map((item) => item.item)).size !==
        facts.damagedItems.length
    )
      reasons.push("An affected item is not in this order.");
    if (!reasons.length) {
      for (const line of order.lines)
        if (facts.damagedItems.some((item) => item.item === line.id))
          add(
            line.id,
            line.unitCents *
              facts.damagedItems.find((item) => item.item === line.id)!
                .quantity,
          );
      if (has("P1.2")) {
        if (
          order.lines.every((line) =>
            facts.damagedItems.some(
              (item) =>
                item.item === line.id && item.quantity === line.quantity,
            ),
          )
        )
          add("shipping", order.shippingCents);
        else
          reasons.push(
            "Shipping is eligible only when every item arrived damaged.",
          );
      }
    }
  }
  if (clauses[0].family === "late") {
    if (!facts.deliveryDates)
      return {
        lines: [],
        reasons: ["Confirm the promised and delivered dates before approval."],
      };
    const late = businessDaysAfter(
      facts.deliveryDates.promisedAt,
      facts.deliveryDates.deliveredAt,
    );
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
    if (!facts.deliveryDates)
      return {
        lines: [],
        reasons: ["Confirm the delivery dates before approval."],
      };
    const age = Math.floor(
      (Date.parse(`${now.slice(0, 10)}T00:00:00Z`) -
        Date.parse(
          `${facts.deliveryDates.deliveredAt.slice(0, 10)}T00:00:00Z`,
        )) /
        day,
    );
    if (!Number.isFinite(age) || age < 0 || age > clause("P3.1").days)
      reasons.push(
        `Return must be within ${clause("P3.1").days} days of delivery.`,
      );
    if (!has("P3.1")) reasons.push("No eligible return clause cited.");
    const returned = facts.returnedItems.map((item) => ({
      ...item,
      line: order.lines.find((line) => line.id === item.item),
    }));
    if (
      !facts.returnReceived ||
      !returned.length ||
      returned.some(
        ({ line, quantity }) =>
          !line ||
          line.sale ||
          !Number.isSafeInteger(quantity) ||
          quantity <= 0 ||
          quantity > line.quantity,
      ) ||
      new Set(returned.map((item) => item.item)).size !== returned.length
    )
      reasons.push(
        "Return has not been received, or all returned items were on sale.",
      );
    if (!reasons.length) {
      let deduction: number = clause("P3.1").deductionCents;
      for (const { line, quantity } of returned) {
        const total = quantity * line!.unitCents;
        const taken = Math.min(total, deduction);
        deduction -= taken;
        add(line!.id, total - taken);
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

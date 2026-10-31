export const policies = [
  {
    id: "P1.1",
    family: "damage",
    rule: "damaged_items",
    text: "Damaged in transit: refund the damaged item price when a photo or clear description is supplied.",
  },
  {
    id: "P1.2",
    family: "damage",
    rule: "all_damaged_shipping",
    text: "Refund shipping only if every item in the order arrived damaged.",
  },
  {
    id: "P2.1",
    family: "late",
    rule: "late_shipping",
    businessDays: 10,
    text: "More than 10 business days past the promised delivery date: refund shipping.",
  },
  {
    id: "P2.2",
    family: "late",
    rule: "late_items",
    businessDays: 20,
    basisPoints: 1500,
    text: "More than 20 business days late: also refund 15% of the item total.",
  },
  {
    id: "P3.1",
    family: "return",
    rule: "received_return",
    days: 30,
    deductionCents: 600,
    text: "Change of mind within 30 days of delivery: refund returned items minus one $6 return-shipping deduction, once the return is received.",
  },
  {
    id: "P3.2",
    family: "return",
    rule: "expired",
    days: 30,
    text: "Change-of-mind returns after 30 days of delivery are not eligible.",
  },
  {
    id: "P3.3",
    family: "return",
    rule: "sale_exclusion",
    text: "Sale items are not eligible for change-of-mind refunds.",
  },
] as const;
export type ClauseId = (typeof policies)[number]["id"];
export function clause<Id extends ClauseId>(
  id: Id,
): Extract<(typeof policies)[number], { id: Id }> {
  return policies.find((policy) => policy.id === id) as Extract<
    (typeof policies)[number],
    { id: Id }
  >;
}

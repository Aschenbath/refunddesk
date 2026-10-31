# Fernleaf Ceramics refund policies

## 1. Damaged in transit
P1.1 — Refund damaged items in full when the customer supplies a photo or a clear description of the damage.

P1.2 — Also refund shipping if every item in the order arrived damaged. Requires P1.1.

## 2. Late delivery
P2.1 — More than 10 business days past the promised delivery date: refund shipping.

P2.2 — More than 20 business days late: also refund 15% of the item total. Requires P2.1. Business days exclude Saturday and Sunday; public holidays are not modelled. Round each line to the nearest cent.

## 3. Change of mind
P3.1 — Within 30 calendar days of delivery, refund the returned item price minus a single $6 return-shipping deduction per case, once the return is marked received. Shipping on the original order is not refunded. Allocate the deduction in order-line order.

P3.2 — Change-of-mind returns after 30 days are not eligible.

P3.3 — Sale items are not eligible for change-of-mind refunds.

Amounts are recomputed from these clause rules in `src/core/policies.ts` and `src/core/calculator.ts`. A human can approve a lower amount, with both amounts visible. Different policy families cannot be stacked in one case.
